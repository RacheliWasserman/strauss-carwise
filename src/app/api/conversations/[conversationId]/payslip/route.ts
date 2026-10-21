import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getConversation } from '@/lib/conversation-repository';
// Relative paths: these run for real in the route tests (the test runner has no '@/' alias).
import { ownsConversation } from '../../../../../lib/persistence-validation';
import { PAYSLIP_LIMITS, VISION_CONSENT_VERSION } from '../../../../../lib/payslip/payslip-contract';
import { extractPayslip, PAYSLIP_ERROR_TEXT, PayslipError } from '../../../../../lib/payslip/payslip-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY = PAYSLIP_LIMITS.maxBytes + 64 * 1024;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** Uploads per employee in a rolling window (per server instance), so visual reading cannot be used in bulk. */
const uploads = new Map<string, number[]>();
function allowUpload(userId: string, now = Date.now()) {
  const recent = (uploads.get(userId) ?? []).filter(time => now - time < 10 * 60_000);
  if (recent.length >= 10 || (!uploads.has(userId) && uploads.size >= 4096)) return false;
  uploads.set(userId, [...recent, now]);
  return true;
}

/** Reads at most MAX_BODY bytes; a larger body is rejected without being buffered. */
async function readCapped(request: Request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

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

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) return json({ error: 'בקשה לא תקינה.' }, 400);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: PAYSLIP_ERROR_TEXT.too_large.text }, 413);
  if (!allowUpload(profile.userId)) return json({ error: 'העלית כמה קבצים ברצף. אפשר לנסות שוב בעוד כמה דקות.' }, 429);
  const body = await readCapped(request);
  if (!body) return json({ error: PAYSLIP_ERROR_TEXT.too_large.text }, 413);
  let file: File;
  let consent = false;
  try {
    const form = await new Request('http://payslip.local/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
    const entry = form.get('file');
    if (!(entry instanceof File) || form.getAll('file').length !== 1) return json({ error: 'יש לצרף קובץ אחד.' }, 400);
    file = entry;
    const consentValue = form.get('consent');
    if (consentValue !== null && consentValue !== VISION_CONSENT_VERSION) return json({ error: 'בקשה לא תקינה.' }, 400);
    consent = consentValue === VISION_CONSENT_VERSION;
  } catch { return json({ error: 'בקשה לא תקינה.' }, 400); }

  try {
    const result = await extractPayslip({ bytes: new Uint8Array(await file.arrayBuffer()), userId: profile.userId, conversationId, consent, ref });
    // Outcome metadata only: never file names, contents, extracted values or identifiers.
    console.info('[carwise.payslip]', { ref, outcome: result.status, method: result.status === 'extracted' ? result.method : null,
      reason: result.status === 'needs_vision' ? result.reason : null, fieldsFound: result.status === 'extracted' ? result.fields.filter(item => item.value !== null).length : 0,
      consent, durationMs: Date.now() - started });
    return json(result);
  } catch (error) {
    const code = error instanceof PayslipError ? error.code : null;
    // Category, stage and provider status only (see VisionDiagnostic): never the key, file, values or upstream text.
    const diagnostic = error instanceof PayslipError ? error.diagnostic : undefined;
    console.warn('[carwise.payslip]', { ref, outcome: 'rejected', code: code ?? 'internal', consent, durationMs: Date.now() - started, ...(diagnostic ? { vision: diagnostic } : {}) });
    if (!code) return json({ error: 'לא הצלחתי לעבד את הקובץ כרגע. אפשר לנסות שוב או להזין את הפרטים ידנית.', ref }, 500);
    return json({ error: PAYSLIP_ERROR_TEXT[code].text, code, ref }, PAYSLIP_ERROR_TEXT[code].status);
  }
}
