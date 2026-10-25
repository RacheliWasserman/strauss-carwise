import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signUp: vi.fn(), signOut: vi.fn(), inUse: vi.fn(), create: vi.fn(), remove: vi.fn(), complete: vi.fn(), names: vi.fn(),
  profile: vi.fn(), role: vi.fn(), queue: vi.fn(), occupations: vi.fn()
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase-server', () => ({ createSupabaseServerClient: async () => ({ auth: { signUp: mocks.signUp, signOut: mocks.signOut } }) }));
vi.mock('../src/lib/identity/identity-repository', () => ({ nationalIdInUse: mocks.inUse, createIdentityForNewUser: mocks.create,
  deleteNewAuthUser: mocks.remove, completeOwnIdentity: mocks.complete, getEmployeeSummaries: mocks.names, getEmployeeOccupations: mocks.occupations }));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/lib/persistence-api-auth', () => ({ requireApiRole: mocks.role }));
vi.mock('@/lib/representative-request-repository', () => ({ listRepresentativeQueue: mocks.queue }));

import { POST as register } from '../src/app/api/auth/register/route';
import { POST as completeIdentity } from '../src/app/api/profile/identity/route';
import { GET as representativeQueue } from '../src/app/api/representative-requests/route';
import { REGISTRATION_RECEIVED } from '../src/lib/auth-errors';

const ID = '039337423';
const valid = { email: 'new.employee@example.com', password: 'long-enough-1', firstName: 'רחלי', lastName: 'כהן', nationalId: '39337423' };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(url, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const newUser = (identities = [{ id: 'identity' }]) => ({ id: 'a1b2c3d4-0000-4000-8000-000000000001', created_at: new Date().toISOString(), identities });
const logged = () => JSON.stringify([(console.info as ReturnType<typeof vi.fn>).mock.calls, (console.warn as ReturnType<typeof vi.fn>).mock.calls]);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.inUse.mockResolvedValue(false);mocks.create.mockResolvedValue('ok');mocks.remove.mockResolvedValue(true);
  mocks.signUp.mockResolvedValue({ data: { user: newUser(), session: null }, error: null });mocks.signOut.mockResolvedValue({});
});

describe('server-side employee sign-up', () => {
  let ip = 0;
  const signUp = (body: unknown, headers: Record<string, string> = {}) =>
    register(post('http://localhost/api/auth/register', body, { 'x-forwarded-for': `10.0.0.${++ip}`, ...headers }));

  it('requires name and a valid national ID, and never accepts a role or extra fields', async () => {
    for (const body of [{ ...valid, nationalId: '123456789' }, { ...valid, firstName: '' }, { ...valid, lastName: '123' },
      { ...valid, role: 'representative' }, { ...valid, options: { data: { role: 'representative' } } }, { email: valid.email, password: valid.password }]) {
      const response = await signUp(body);
      expect(response.status).toBe(400);
    }
    expect((await (await signUp({ ...valid, nationalId: '123456789' })).json()).error).toContain('תעודת הזהות');
    expect(mocks.signUp).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();
  });
  it('creates the account, then stores the identity (normalized ID) without putting it in user metadata', async () => {
    const response = await signUp(valid);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ status: 'confirm_email' });
    const [args] = mocks.signUp.mock.calls[0];
    expect(args).toEqual({ email: valid.email, password: valid.password, options: { emailRedirectTo: 'http://localhost/auth/callback' } });
    expect(JSON.stringify(args)).not.toContain(ID.slice(1));expect(JSON.stringify(args)).not.toContain('רחלי');
    expect(mocks.create).toHaveBeenCalledWith(newUser().id, { firstName: 'רחלי', lastName: 'כהן', nationalId: ID });
    expect(logged()).not.toContain(ID.slice(1));expect(logged()).not.toContain(valid.email);
  });
  it('signs in directly when e-mail confirmation is off', async () => {
    mocks.signUp.mockResolvedValue({ data: { user: newUser(), session: { access_token: 'x' } }, error: null });
    expect(await (await signUp(valid)).json()).toEqual({ status: 'signed_in' });
  });
  it('an already-registered address gets the same answer and no identity is written', async () => {
    mocks.signUp.mockResolvedValue({ data: { user: newUser([]), session: null }, error: null });
    const response = await signUp(valid);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ status: 'confirm_email' });
    expect(mocks.create).not.toHaveBeenCalled();expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('an ID used by another account gets exactly the answer of an ordinary sign-up, and no account is created', async () => {
    const ordinary = await signUp(valid);
    const ordinaryBody = await ordinary.json();
    mocks.signUp.mockClear();mocks.create.mockClear();
    mocks.inUse.mockResolvedValue(true);
    const duplicate = await signUp({ ...valid, email: 'someone.else@example.com' });
    expect(duplicate.status).toBe(ordinary.status);expect(await duplicate.json()).toEqual(ordinaryBody);
    expect(mocks.signUp).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();
  });
  it('if the identity cannot be stored, the account just created is removed (all-or-nothing)', async () => {
    mocks.create.mockResolvedValue('conflict');
    const raced = await signUp(valid);
    expect(raced.status).toBe(200);expect(await raced.json()).toMatchObject({ status: 'confirm_email' }); // Non-enumerating.
    expect(mocks.remove).toHaveBeenCalledWith(newUser().id);
    mocks.create.mockResolvedValue('failed');mocks.remove.mockResolvedValue(false);
    const kept = await signUp(valid);
    expect(kept.status).toBe(202);expect((await kept.json()).error).toContain('להשלים');
  });
  it('an older account is never removed by a failed retry', async () => {
    mocks.signUp.mockResolvedValue({ data: { user: { ...newUser(), created_at: '2026-01-01T00:00:00.000Z' }, session: null }, error: null });
    mocks.create.mockResolvedValue('failed');
    await signUp(valid);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('identity storage not deployed yet (migration pending): the account still works; profile completion follows later', async () => {
    mocks.create.mockResolvedValue('unavailable');
    expect((await signUp(valid)).status).toBe(200);expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('every sign-up that waits for confirmation gets ONE truthful answer that never claims an e-mail was sent', async () => {
    const answers: Array<{ status: number; body: unknown }> = [];
    const record = async (response: Response) => answers.push({ status: response.status, body: await response.json() });
    await record(await signUp(valid)); // A new account.
    mocks.signUp.mockResolvedValue({ data: { user: newUser([]), session: null }, error: null });
    await record(await signUp(valid)); // An address that already has an account.
    mocks.signUp.mockResolvedValue({ data: { user: newUser(), session: null }, error: null });
    mocks.inUse.mockResolvedValue(true);
    await record(await signUp({ ...valid, email: 'someone.else@example.com' })); // An ID of another account.
    mocks.inUse.mockResolvedValue(false);mocks.create.mockResolvedValue('conflict');
    await record(await signUp(valid)); // The same ID registered concurrently: the new account was removed.
    expect(answers.every(answer => JSON.stringify(answer) === JSON.stringify(answers[0]))).toBe(true);
    expect(answers[0]).toEqual({ status: 200, body: { status: 'confirm_email', message: REGISTRATION_RECEIVED } });
    expect(REGISTRATION_RECEIVED).not.toMatch(/נשלח אימייל|נשלחה|הצלחה|נוצר/);
    expect(REGISTRATION_RECEIVED).toContain('ייתכן שכבר קיים חשבון');
  });
  it('a duplicate ID creates, changes and removes no account, and the ID is never in the answer or the logs', async () => {
    mocks.inUse.mockResolvedValue(true);
    const response = await signUp({ ...valid, email: 'someone.else@example.com' });
    expect(mocks.signUp).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();expect(mocks.signOut).not.toHaveBeenCalled();
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(ID.slice(1));expect(body).not.toContain(ID.slice(-4));
    expect(logged()).not.toContain(ID.slice(1));expect(logged()).not.toContain('someone.else@example.com');
    expect(logged()).toContain('identity_conflict');
  });
  it('invalid data and temporary failures are errors, never the confirmation answer', async () => {
    const invalid = await signUp({ ...valid, nationalId: '123456789' });
    expect(invalid.status).toBe(400);expect(await invalid.json()).toEqual({ error: expect.stringContaining('תעודת הזהות') });
    mocks.inUse.mockResolvedValue(null); // The uniqueness check is unavailable: nothing is created.
    const unavailable = await signUp(valid);
    expect(unavailable.status).toBe(503);expect((await unavailable.json()).status).toBeUndefined();
    expect(mocks.signUp).not.toHaveBeenCalled();
    mocks.inUse.mockResolvedValue(false);
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'Email rate limit exceeded' } });
    const limited = await signUp(valid);
    expect(limited.status).toBe(429);expect((await limited.json()).status).toBeUndefined();
    mocks.signUp.mockResolvedValue({ data: { user: newUser(), session: null }, error: null });
    mocks.create.mockResolvedValue('failed');mocks.remove.mockResolvedValue(true);
    const failed = await signUp(valid);
    expect(failed.status).toBe(500);expect((await failed.json()).error).toContain('לא הושלמה');
  });
  it('the form shows the confirmation answer as a neutral notice, never as a green success', async () => {
    const { readFileSync } = await import('node:fs');
    const form = readFileSync(new URL('../src/components/auth-form.tsx', import.meta.url), 'utf8');
    expect(form).not.toContain('נשלח אימייל');
    expect(form).toMatch(/if \(response\.ok\) \{[^}]*setMessageTone\('notice'\)[^}]*REGISTRATION_RECEIVED/);
    expect(form).toMatch(/messageTone === 'notice' \? 'auth-notice' : 'auth-success'/);
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.auth-notice\{/);
  });
  it('rejects cross-site requests and repeated attempts', async () => {
    expect((await signUp(valid, { origin: 'https://evil.example' })).status).toBe(403);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) statuses.push((await register(post('http://localhost/api/auth/register', valid, { 'x-forwarded-for': '192.0.2.7' }))).status);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('profile completion for existing accounts', () => {
  const complete = (body: unknown) => completeIdentity(post('http://localhost/api/profile/identity', body));
  it('requires a signed-in employee', async () => {
    mocks.profile.mockResolvedValue(null);
    expect((await complete(valid)).status).toBe(401);
    mocks.profile.mockResolvedValue({ userId: 'rep', role: 'representative' });
    expect((await complete({ firstName: 'רחלי', lastName: 'כהן', nationalId: ID })).status).toBe(403);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('validates server-side, stores once through the employee session, and never returns the ID', async () => {
    mocks.profile.mockResolvedValue({ userId: 'employee', role: 'employee' });
    expect((await complete({ firstName: 'רחלי', lastName: 'כהן', nationalId: '123456789' })).status).toBe(400);
    expect((await complete({ firstName: 'רחלי', lastName: 'כהן', nationalId: ID, userId: 'someone-else' })).status).toBe(400);
    mocks.complete.mockResolvedValue('ok');
    const ok = await complete({ firstName: ' רחלי ', lastName: 'כהן', nationalId: '39337423' });
    expect(ok.status).toBe(200);expect(JSON.stringify(await ok.json())).not.toContain(ID);
    expect(mocks.complete).toHaveBeenCalledWith({ firstName: 'רחלי', lastName: 'כהן', nationalId: ID });
    mocks.complete.mockResolvedValue('exists');
    expect((await complete({ firstName: 'דנה', lastName: 'לוי', nationalId: ID })).status).toBe(409);
    mocks.complete.mockResolvedValue('unavailable');
    expect((await complete({ firstName: 'רחלי', lastName: 'כהן', nationalId: ID })).status).toBe(503);
    // A duplicate ID answers exactly like any other storage failure.
    mocks.complete.mockResolvedValue('conflict');
    const duplicate = await complete({ firstName: 'רחלי', lastName: 'כהן', nationalId: ID });
    mocks.complete.mockResolvedValue('failed');
    const failed = await complete({ firstName: 'רחלי', lastName: 'כהן', nationalId: ID });
    expect(duplicate.status).toBe(failed.status);expect(await duplicate.json()).toEqual(await failed.json());
    expect(logged()).not.toContain(ID.slice(1));
  });
});

describe('representative queue shows names through the server, never IDs or conversations', () => {
  it('adds the stored name per visible request and omits owner IDs', async () => {
    mocks.role.mockResolvedValue({ profile: { userId: 'rep', role: 'representative' } });
    mocks.queue.mockResolvedValue([{ id: 'r1', conversation_id: 'c1', owner_user_id: 'u1', status: 'open', topic: 'שדה חסר: בונוס חודשי [bonus]',
      assigned_representative_id: null, requested_at: '2026-10-21T10:00:00.000Z', answered_at: null, claimed_at: null, closed_at: null,
      created_at: '2026-10-21T10:00:00.000Z', updated_at: '2026-10-21T10:00:00.000Z' }]);
    mocks.names.mockResolvedValue(new Map([['u1', { name: 'רחלי כהן', idLast4: '7423' }]]));
    mocks.occupations.mockResolvedValue(new Map([['u1', 'מנהל/ת אזור מכירות']]));
    const body = await (await representativeQueue()).json();
    expect(body.requests).toEqual([{ id: 'r1', conversation_id: 'c1', status: 'open', topic: 'שדה חסר: בונוס חודשי [bonus]', assigned_representative_id: null,
      requested_at: '2026-10-21T10:00:00.000Z', answered_at: null, employee_name: 'רחלי כהן', employee_id_last4: '7423', occupation: 'מנהל/ת אזור מכירות' }]);
    expect(mocks.names).toHaveBeenCalledWith(['u1']);
    expect(JSON.stringify(body)).not.toMatch(/national|owner_user_id|salary|base_salary|\d{5,}/); // Never more than four ID digits.
    expect(body.requests[0].employee_id_last4).toHaveLength(4);
    expect(mocks.occupations).toHaveBeenCalledWith(['u1']);
  });
  it('a request whose owner has no identity record (or before the migration) shows no name, never a guessed one', async () => {
    mocks.role.mockResolvedValue({ profile: { userId: 'rep', role: 'representative' } });
    mocks.queue.mockResolvedValue([{ id: 'r2', conversation_id: 'c2', owner_user_id: 'u2', status: 'claimed', topic: null, assigned_representative_id: 'rep',
      requested_at: '2026-10-21T10:00:00.000Z', answered_at: null }]);
    mocks.names.mockResolvedValue(new Map());mocks.occupations.mockResolvedValue(new Map());
    const body = await (await representativeQueue()).json();
    expect(body.requests[0]).toMatchObject({ employee_name: null, employee_id_last4: null, occupation: null });
  });
  it('is closed to employees', async () => {
    const { NextResponse } = await import('next/server');
    mocks.role.mockResolvedValue({ response: NextResponse.json({ error: 'אין הרשאה' }, { status: 403 }) });
    expect((await representativeQueue()).status).toBe(403);expect(mocks.queue).not.toHaveBeenCalled();
  });
});
