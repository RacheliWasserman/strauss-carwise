import 'server-only';
import type { IdentityInput } from './employee-identity';

/**
 * Account identity storage (table advisor_employee_identities, migration 202610210001).
 * Until that migration is applied every read reports 'unavailable' and the application keeps its previous
 * behaviour: nobody is blocked, and the advisor still asks for a display name as before.
 * The national ID is written here and never read back by the application.
 */
export type OwnIdentity =
  | { status: 'complete'; firstName: string; lastName: string }
  | { status: 'missing' }
  | { status: 'unavailable' };
type DbError = { code?: string } | null;
/** The table or function does not exist yet (migration not applied). */
const notDeployed = (error: DbError) => ['42P01', '42883', 'PGRST202', 'PGRST205', 'PGRST204'].includes(error?.code ?? '');

/** Why identity is unavailable, in the server log only (error codes; never names, IDs or user IDs). */
const report = (phase: string, error: DbError) => console.warn('[carwise.identity]', { phase,
  outcome: notDeployed(error) ? 'table_missing_apply_migration_202610210001' : 'read_failed', code: error?.code ?? null });

const admin = async () => (await import('../supabase-admin')).supabaseAdmin;
const session = async () => (await import('../supabase-server')).createSupabaseServerClient();

/** The signed-in employee's own name, through their session (RLS: own row, name columns only). */
export async function getOwnIdentity(userId: string): Promise<OwnIdentity> {
  try {
    const { data, error } = await (await session()).from('advisor_employee_identities')
      .select('first_name, last_name').eq('user_id', userId).maybeSingle();
    if (error) { report('own_identity', error); return { status: 'unavailable' }; }
    if (!data) return { status: 'missing' };
    return { status: 'complete', firstName: String(data.first_name), lastName: String(data.last_name) };
  } catch { return { status: 'unavailable' }; }
}

export type WriteOutcome = 'ok' | 'conflict' | 'exists' | 'unavailable' | 'failed';

/** Profile completion through the employee's own session (SECURITY DEFINER function, insert-only). */
export async function completeOwnIdentity(input: IdentityInput): Promise<WriteOutcome> {
  try {
    const { error } = await (await session()).rpc('advisor_complete_employee_identity',
      { p_first_name: input.firstName, p_last_name: input.lastName, p_national_id: input.nationalId });
    if (!error) return 'ok';
    if (notDeployed(error)) return 'unavailable';
    // The database function answers a duplicate ID with its generic 'could not be saved' (P0001), i.e. 'failed'.
    return error.code === '23505' ? 'conflict' : error.code === 'P0002' ? 'exists' : 'failed';
  } catch { return 'failed'; }
}

/** Sign-up: the new account has no session yet when e-mail confirmation is on, so the server writes the row. */
export async function createIdentityForNewUser(userId: string, input: IdentityInput): Promise<WriteOutcome> {
  try {
    const { error } = await (await admin()).from('advisor_employee_identities').insert({ user_id: userId,
      first_name: input.firstName, last_name: input.lastName, national_id: input.nationalId, source: 'signup' });
    if (!error) return 'ok';
    if (notDeployed(error)) return 'unavailable';
    return error.code === '23505' ? 'conflict' : 'failed';
  } catch { return 'failed'; }
}

/** Whether another account already registered this ID. Null when it cannot be checked. */
export async function nationalIdInUse(nationalId: string): Promise<boolean | null> {
  try {
    const { data, error } = await (await admin()).from('advisor_employee_identities').select('user_id').eq('national_id', nationalId).limit(1);
    if (error) return notDeployed(error) ? false : null;
    return Boolean(data?.length);
  } catch { return null; }
}

/** Removes an account created moments ago whose identity could not be stored (keeps sign-up all-or-nothing). */
export async function deleteNewAuthUser(userId: string): Promise<boolean> {
  try { return !(await (await admin()).auth.admin.deleteUser(userId)).error; } catch { return false; }
}

/**
 * The occupation title of each request owner's latest approved profile, for the representative's screen.
 * Only the title column is read: no salary, contribution or vehicle value ever leaves the server this way.
 */
export async function getEmployeeOccupations(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].slice(0, 200);
  if (!ids.length) return new Map();
  try {
    const { data, error } = await (await admin()).from('advisor_employee_data_versions').select('user_id, occupation_title, version')
      .in('user_id', ids).eq('status', 'confirmed').order('version', { ascending: false }).limit(2000);
    if (error || !data) return new Map();
    const titles = new Map<string, string>();
    for (const row of data) if (!titles.has(String(row.user_id))) titles.set(String(row.user_id), String(row.occupation_title));
    return titles;
  } catch { return new Map(); }
}

export type EmployeeSummary = { name: string; idLast4: string | null };
/**
 * Name and the stored last four ID digits of request owners, for the representative queue. Callers pass only owners
 * of requests the representative may already see (RLS-scoped list). The full national_id column is never selected:
 * the last four digits are a separate generated column, so the full ID never reaches this code path.
 */
export async function getEmployeeSummaries(userIds: string[]): Promise<Map<string, EmployeeSummary>> {
  const ids = [...new Set(userIds)].slice(0, 200);
  if (!ids.length) return new Map();
  try {
    const { data, error } = await (await admin()).from('advisor_employee_identities').select('user_id, first_name, last_name, national_id_last4').in('user_id', ids);
    if (error) report('representative_summaries', error);
    if (error || !data) return new Map();
    return new Map(data.map(row => [String(row.user_id), { name: `${row.first_name} ${row.last_name}`.trim(),
      idLast4: /^\d{4}$/.test(String(row.national_id_last4 ?? '')) ? String(row.national_id_last4) : null }]));
  } catch { return new Map(); }
}

/**
 * The full national ID of a request's owner, through the representative's OWN session. The database function
 * (migration 202610210003) returns it only to the representative assigned to this request while it is 'claimed',
 * records the access, and raises one generic error otherwise. Any failure here is reported as null, without detail.
 */
export async function revealRequestNationalId(requestId: string): Promise<string | null> {
  try {
    const { data, error } = await (await session()).rpc('advisor_reveal_request_national_id', { p_request_id: requestId });
    if (error) { console.warn('[carwise.identity]', { phase: 'reveal', outcome: notDeployed(error) ? 'function_missing_apply_migration_202610210003' : 'refused' }); return null; }
    return typeof data === 'string' && /^\d{9}$/.test(data) ? data : null;
  } catch { return null; }
}
