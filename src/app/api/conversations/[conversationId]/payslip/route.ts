import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getConversation } from '@/lib/conversation-repository';
// Relative paths: these run for real in the route tests (the test runner has no '@/' alias).
import { ownsConversation } from '../../../../../lib/persistence-validation';
import { payslipJson as json, runPayslipUpload } from '../../../../../lib/payslip/payslip-upload-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Reads payslip fields from an uploaded file for the employee's own review. The file is processed in memory only:
 * it is not stored, not added to the conversation and not logged. Nothing is sent to an external provider unless
 * the request carries the employee's consent for this specific upload.
 */
export async function POST(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const started = Date.now();
  // Correlation reference: shown to the employee on failure and written to the server log, to match the two.
  const ref = randomUUID().replace(/-/g, '').slice(0, 8);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'אין הרשאה לפעולה הזו.' }, 403);
  const profile = await getAuthenticatedProfile();
  if (!profile) return json({ error: 'כדי להמשיך, צריך להתחבר שוב.' }, 401);
  if (profile.role !== 'employee') return json({ error: 'אין הרשאה לפעולה הזו.' }, 403);
  const { conversationId } = await params;
  if (!z.string().uuid().safeParse(conversationId).success) return json({ error: 'מזהה השיחה אינו תקין.' }, 400);
  const conversation = await getConversation(conversationId, profile.userId, profile.role).catch(() => null);
  if (!conversation || !ownsConversation(conversation.owner_user_id, profile.userId, profile.role)) return json({ error: 'השיחה לא נמצאה.' }, 404);
  return runPayslipUpload(request, { userId: profile.userId, scope: conversationId, ref, started });
}
