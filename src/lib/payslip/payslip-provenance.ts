import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PAYSLIP_FIELD_ORDER, type ExtractionMethod, type PayslipField } from './payslip-contract';

/**
 * A signature over exactly what was extracted, for whom and in which conversation. It lets the advisor mark a
 * reviewed value as "מתלוש" only when it is identical to what the server itself read from the document.
 * The key is derived from an existing server secret; no new configuration is needed and nothing is stored.
 */
const VALID_MS = 60 * 60 * 1000;
function key() {
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secret) throw new Error('Payslip provenance key unavailable');
  return createHash('sha256').update(`carwise.payslip-provenance.v1|${secret}`).digest();
}
type Extracted = Record<PayslipField, number | null>;
const payload = (userId: string, conversationId: string, method: ExtractionMethod, extracted: Extracted, expiresAt: string) =>
  ['v1', userId, conversationId, method, expiresAt, ...PAYSLIP_FIELD_ORDER.map(field => `${field}=${extracted[field] ?? 'null'}`)].join('|');

export function signExtraction(userId: string, conversationId: string, method: ExtractionMethod, extracted: Extracted, now = Date.now()) {
  const expiresAt = new Date(now + VALID_MS).toISOString();
  const token = createHmac('sha256', key()).update(payload(userId, conversationId, method, extracted, expiresAt)).digest('hex');
  return { token, expiresAt };
}

export function verifyExtraction(userId: string, conversationId: string, method: ExtractionMethod, extracted: Extracted,
  expiresAt: string, token: string, now = Date.now()): 'valid' | 'expired' | 'invalid' {
  let expected: Buffer;
  try { expected = createHmac('sha256', key()).update(payload(userId, conversationId, method, extracted, expiresAt)).digest(); }
  catch { return 'invalid'; }
  const given = Buffer.from(token, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  return Date.parse(expiresAt) < now ? 'expired' : 'valid';
}
