import { NextResponse } from 'next/server';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
// Relative paths: these run for real in the route tests (the test runner has no '@/' alias).
import { firstIssue, identityInputSchema } from '../../../../lib/identity/employee-identity';
import { completeOwnIdentity } from '../../../../lib/identity/identity-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Profile completion for employee accounts without stored identity (created before this feature, or whose
 * sign-up was interrupted). Insert-only through the employee's own session; an existing identity is never
 * overwritten from the client. The response never contains the ID.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'אין הרשאה לפעולה הזו.' }, 403);
  const profile = await getAuthenticatedProfile();
  if (!profile) return json({ error: 'כדי להמשיך, צריך להתחבר שוב.' }, 401);
  if (profile.role !== 'employee') return json({ error: 'אין הרשאה לפעולה הזו.' }, 403);
  let parsed;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'בקשה לא תקינה.' }, 400);
    parsed = identityInputSchema.safeParse(JSON.parse(raw));
  } catch { return json({ error: 'בקשה לא תקינה.' }, 400); }
  if (!parsed.success) return json({ error: firstIssue(parsed.error) }, 400);
  const outcome = await completeOwnIdentity(parsed.data);
  console.info('[carwise.identity]', { outcome });
  if (outcome === 'ok') return json({ status: 'complete' });
  if (outcome === 'exists') return json({ error: 'הפרטים כבר הושלמו בחשבון הזה. לשינוי יש לפנות לתמיכה.' }, 409);
  if (outcome === 'unavailable') return json({ error: 'השלמת הפרטים עדיין לא זמינה. אפשר להמשיך להשתמש במערכת.' }, 503);
  // A duplicate ID and any other storage failure get one identical answer, so the form is not an ID oracle.
  return json({ error: 'לא ניתן לשמור את הפרטים כרגע. אפשר לנסות שוב, ואם זה חוזר יש לפנות לתמיכה.' }, 422);
}
