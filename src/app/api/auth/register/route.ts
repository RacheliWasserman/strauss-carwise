import { NextResponse } from 'next/server';
// Relative paths: these run for real in the route tests (the test runner has no '@/' alias).
import { firstIssue, registrationSchema } from '../../../../lib/identity/employee-identity';
import { createIdentityForNewUser, deleteNewAuthUser, nationalIdInUse } from '../../../../lib/identity/identity-repository';
import { getHebrewAuthError } from '../../../../lib/auth-errors';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { authOrigin } from '../../../../lib/auth-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const CONFIRM = 'נשלח אימייל לאישור החשבון. אחרי האישור אפשר להתחבר.';

const attempts = new Map<string, number[]>();
function allow(key: string, now = Date.now()) {
  const recent = (attempts.get(key) ?? []).filter(time => now - time < 10 * 60_000);
  if (recent.length >= 8 || (!attempts.has(key) && attempts.size >= 4096)) return false;
  attempts.set(key, [...recent, now]);
  return true;
}

/**
 * Employee sign-up on the server, so name and national ID are validated and stored with the account.
 * The role is never accepted from the client: the existing database trigger always creates 'employee'.
 * The ID goes only to the identity table (never to user metadata, the session token, logs or the advisor).
 * If the identity cannot be stored, the account just created is removed, so a retry starts clean; anything
 * left incomplete is caught by the profile-completion step at the next sign-in.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const self = new URL(request.url).origin;
  if (origin && origin !== self) return json({ error: 'אין הרשאה לפעולה הזו.' }, 403);
  let callbackOrigin: string;
  try { callbackOrigin = authOrigin(request.url); }
  catch { return json({ error: 'ההרשמה אינה זמינה כרגע. יש לבדוק את הגדרת כתובת האתר.' }, 503); }
  if (!allow(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local')) {
    return json({ error: 'בוצעו יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות.' }, 429);
  }
  let parsed;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'בקשה לא תקינה.' }, 400);
    parsed = registrationSchema.safeParse(JSON.parse(raw));
  } catch { return json({ error: 'בקשה לא תקינה.' }, 400); }
  if (!parsed.success) return json({ error: firstIssue(parsed.error) }, 400);
  const { email, password, ...identity } = parsed.data;

  const inUse = await nationalIdInUse(identity.nationalId);
  if (inUse === null) return json({ error: 'לא ניתן להירשם כרגע. אפשר לנסות שוב בעוד רגע.' }, 503);
  // Non-enumerating: an ID registered to another account gets exactly the answer of an ordinary sign-up, and no
  // account is created. (The owner of the address simply receives no e-mail.)
  if (inUse) {
    console.info('[carwise.register]', { outcome: 'identity_conflict' });
    // Roughly the time a real sign-up takes, so the response time does not reveal that no account was created.
    await new Promise(resolve => setTimeout(resolve, 350 + Math.floor(Math.random() * 450)));
    return json({ status: 'confirm_email', message: CONFIRM });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${callbackOrigin}/auth/callback` } });
  if (error) {
    const message = getHebrewAuthError(error.message);
    console.info('[carwise.register]', { outcome: 'auth_rejected' });
    return json({ error: message }, /rate limit/i.test(error.message) ? 429 : 400);
  }
  const user = data.user;
  // An already-registered address returns an obfuscated user without identities: say the same as for a new one.
  if (!user || !user.identities?.length) { console.info('[carwise.register]', { outcome: 'existing_or_unknown' }); return json({ status: 'confirm_email', message: CONFIRM }); }

  const stored = await createIdentityForNewUser(user.id, identity);
  console.info('[carwise.register]', { outcome: 'created', identity: stored, session: Boolean(data.session) });
  if (stored === 'ok' || stored === 'unavailable') {
    return json(data.session ? { status: 'signed_in' } : { status: 'confirm_email', message: CONFIRM });
  }
  // Only an account created by this request (seconds ago) is ever removed.
  const fresh = Date.now() - Date.parse(user.created_at) < 120_000;
  const removed = fresh && await deleteNewAuthUser(user.id);
  if (data.session) await supabase.auth.signOut().catch(() => undefined);
  console.warn('[carwise.register]', { outcome: 'identity_failed', removed });
  // A concurrent duplicate: the new account was removed; answer like an ordinary sign-up (non-enumerating).
  if (stored === 'conflict' && removed) return json({ status: 'confirm_email', message: CONFIRM });
  return json({ error: removed ? 'ההרשמה לא הושלמה. אפשר לנסות שוב.' : 'החשבון נפתח, אבל הפרטים האישיים לא נשמרו. אחרי ההתחברות תתבקשו להשלים אותם.' }, removed ? 500 : 202);
}
