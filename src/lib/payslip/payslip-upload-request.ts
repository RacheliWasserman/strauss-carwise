import 'server-only';
import { NextResponse } from 'next/server';
import { PAYSLIP_LIMITS, VISION_CONSENT_VERSION } from './payslip-contract';
import { extractPayslip, PAYSLIP_ERROR_TEXT, PayslipError } from './payslip-service';

/**
 * The upload half of payslip reading, shared by the chat (per conversation) and "הפרופיל שלי". The caller has already
 * authenticated the employee; this checks the request, applies one upload limit per employee across both places,
 * and runs the same extraction. The file is processed in memory only: not stored, not logged, and never sent to an
 * external provider without the employee's consent for this specific upload.
 */
const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY = PAYSLIP_LIMITS.maxBytes + 64 * 1024;
export const payslipJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

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
 * `scope` binds the extraction's signature to where it will be reviewed: the conversation ID in the chat, or
 * "profile" for the profile page (where the employee saves the reviewed values directly).
 */
export async function runPayslipUpload(request: Request, input: { userId: string; scope: string; ref: string; started: number }) {
  const { userId, scope, ref, started } = input;
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) return payslipJson({ error: 'בקשה לא תקינה.' }, 400);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return payslipJson({ error: PAYSLIP_ERROR_TEXT.too_large.text }, 413);
  if (!allowUpload(userId)) return payslipJson({ error: 'העלית כמה קבצים ברצף. אפשר לנסות שוב בעוד כמה דקות.' }, 429);
  const body = await readCapped(request);
  if (!body) return payslipJson({ error: PAYSLIP_ERROR_TEXT.too_large.text }, 413);
  let file: File;
  let consent = false;
  try {
    const form = await new Request('http://payslip.local/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
    const entry = form.get('file');
    if (!(entry instanceof File) || form.getAll('file').length !== 1) return payslipJson({ error: 'יש לצרף קובץ אחד.' }, 400);
    file = entry;
    const consentValue = form.get('consent');
    if (consentValue !== null && consentValue !== VISION_CONSENT_VERSION) return payslipJson({ error: 'בקשה לא תקינה.' }, 400);
    consent = consentValue === VISION_CONSENT_VERSION;
  } catch { return payslipJson({ error: 'בקשה לא תקינה.' }, 400); }

  try {
    const result = await extractPayslip({ bytes: new Uint8Array(await file.arrayBuffer()), userId, conversationId: scope, consent, ref });
    // Outcome metadata only: never file names, contents, extracted values or identifiers.
    console.info('[carwise.payslip]', { ref, outcome: result.status, method: result.status === 'extracted' ? result.method : null,
      reason: result.status === 'needs_vision' ? result.reason : null, fieldsFound: result.status === 'extracted' ? result.fields.filter(item => item.value !== null).length : 0,
      consent, durationMs: Date.now() - started });
    return payslipJson(result);
  } catch (error) {
    const code = error instanceof PayslipError ? error.code : null;
    // Category, stage and provider status only (see VisionDiagnostic): never the key, file, values or upstream text.
    const diagnostic = error instanceof PayslipError ? error.diagnostic : undefined;
    console.warn('[carwise.payslip]', { ref, outcome: 'rejected', code: code ?? 'internal', consent, durationMs: Date.now() - started, ...(diagnostic ? { vision: diagnostic } : {}) });
    if (!code) return payslipJson({ error: 'לא הצלחתי לעבד את הקובץ כרגע. אפשר לנסות שוב או להזין את הפרטים ידנית.', ref }, 500);
    return payslipJson({ error: PAYSLIP_ERROR_TEXT[code].text, code, ref }, PAYSLIP_ERROR_TEXT[code].status);
  }
}
