import { NextResponse } from 'next/server';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
// Relative paths: these run for real in the route tests (the test runner has no '@/' alias).
import { getOwnIdentity } from '../../../lib/identity/identity-repository';
import { profileSaveSchema } from '../../../lib/profile/profile-form';
import { saveOwnProfile } from '../../../lib/profile/profile-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * "הפרופיל שלי": saves the signed-in employee's own profile as a new approved version (the same record the chat uses).
 * Only the employee's own session writes (RLS); the role and the current car are checked against the official lists.
 * Logs carry the outcome only, never a salary or any other value.
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
    if (raw.length > 4096) return json({ error: 'בקשה לא תקינה.' }, 400);
    parsed = profileSaveSchema.safeParse(JSON.parse(raw));
  } catch { return json({ error: 'בקשה לא תקינה.' }, 400); }
  if (!parsed.success) return json({ error: 'חלק מהפרטים אינם תקינים. כדאי לבדוק את השדות ולנסות שוב.' }, 400);

  const outcome = await saveOwnProfile(profile.userId, parsed.data, await getOwnIdentity(profile.userId));
  console.info('[carwise.profile]', { outcome: outcome.status });
  switch (outcome.status) {
    case 'saved': case 'unchanged': return json({ status: outcome.status, snapshot: outcome.snapshot });
    case 'stale': return json({ error: 'הפרופיל עודכן בינתיים (למשל באישור בשיחה). הגרסה העדכנית נטענה לטופס; כדאי לבדוק אותה ולשמור שוב.',
      code: 'stale', snapshot: outcome.snapshot }, 409);
    case 'invalid_occupation': return json({ error: 'התפקיד שנבחר אינו ברשימת התפקידים הרשמית. יש לבחור תפקיד מהרשימה.', code: outcome.status }, 422);
    case 'invalid_vehicle': return json({ error: 'הרכב שנבחר אינו בקטלוג הפעיל. יש לבחור רכב מהרשימה.', code: outcome.status }, 422);
    case 'name_required': return json({ error: 'יש למלא שם פרטי ושם משפחה.', code: outcome.status }, 422);
    case 'unavailable': return json({ error: 'לא הצלחתי לטעון כרגע את רשימות התפקידים והרכבים. אפשר לנסות שוב בעוד רגע.' }, 503);
    default: return json({ error: 'לא הצלחתי לשמור את הפרופיל כרגע. אפשר לנסות שוב.' }, 500);
  }
}
