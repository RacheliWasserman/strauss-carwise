import { randomUUID } from 'node:crypto';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
// Relative paths: these run for real in the route tests (the test runner has no '@/' alias).
import { payslipJson as json, runPayslipUpload } from '../../../../lib/payslip/payslip-upload-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Payslip reading for "הפרופיל שלי": the same extraction, limits and consent rules as in the chat. The result only
 * fills the profile form for review; nothing is saved until the employee saves the profile.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const ref = randomUUID().replace(/-/g, '').slice(0, 8);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'אין הרשאה לפעולה הזו.' }, 403);
  const profile = await getAuthenticatedProfile();
  if (!profile) return json({ error: 'כדי להמשיך, צריך להתחבר שוב.' }, 401);
  if (profile.role !== 'employee') return json({ error: 'אין הרשאה לפעולה הזו.' }, 403);
  return runPayslipUpload(request, { userId: profile.userId, scope: 'profile', ref, started });
}
