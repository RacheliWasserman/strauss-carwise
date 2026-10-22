import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

/**
 * LIVE FAILURE (2026-10-22, ref 5130a631): the first live request with the candidate schema was refused by Gemini with
 * HTTP 400 INVALID_ARGUMENT ("Request contains an invalid argument.") and the employee saw "vision_rejected".
 * Blank-image probes (no document) isolated the cause: the bounded candidate array. The same request was accepted with
 * maxItems 7 or with no maxItems, and refused with 14, 20 and 40; changing the required fields or removing the section
 * enum did not help. The simulated SDK below applies exactly that observed rule, with Google's exact error envelope.
 */
const GOOGLE_400 = '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
function largestBoundedArray(schema: Json): number {
  if (Array.isArray(schema)) return Math.max(0, ...schema.map(item => largestBoundedArray(item as Json)));
  if (!schema || typeof schema !== 'object') return 0;
  const own = schema.type === 'array' && typeof schema.maxItems === 'number' ? schema.maxItems : 0;
  return Math.max(own, ...Object.values(schema).map(value => largestBoundedArray(value as Json)));
}
/** What the live service did with this item schema. */
const OBSERVED_LIMIT = 7;
const validResponse = { is_payslip: true, legibility: 'good', candidates: [
  { field: 'base_salary', label_text: 'שכר יסוד', value_text: '18,500.00', section: 'earnings', period: 'current_month', unit: 'currency', page: 1 },
  { field: 'bonus', label_text: 'מענק חד־פעמי', value_text: '3,500.00', section: 'earnings', period: 'current_month', unit: 'currency', recurrence: 'one_time' },
  { field: 'bonus', label_text: 'בונוס חודשי קבוע', value_text: '1,000.00', section: 'earnings', period: 'current_month', unit: 'currency', recurrence: 'recurring' }] };

const generateContent = vi.fn(async (request: { config: { responseJsonSchema: Json } }) => {
  if (largestBoundedArray(request.config.responseJsonSchema) > OBSERVED_LIMIT) throw Object.assign(new Error(GOOGLE_400), { status: 400 });
  return { text: JSON.stringify(validResponse), candidates: [{ finishReason: 'STOP' }] };
});
vi.mock('@google/genai', () => ({ GoogleGenAI: vi.fn(() => ({ models: { generateContent } })) }));

import { geminiVision, readWithVision, VISION_MAX_CANDIDATES, VISION_RESPONSE_JSON_SCHEMA, type VisionCall } from '../src/lib/payslip/payslip-vision';
import { extractPayslip, PayslipError } from '../src/lib/payslip/payslip-service';
import { geminiDiagnostic } from '../src/lib/ai/gemini-diagnostics';

process.env.SUPABASE_SECRET_KEY ||= 'test-only-secret';
const document = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const };
const signal = () => new AbortController().signal;
let key: string | undefined;
beforeEach(() => { key = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'test-key-not-real'; generateContent.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; vi.restoreAllMocks(); });

describe('Gemini structured-output schema (live 400 INVALID_ARGUMENT, ref 5130a631)', () => {
  it('the schema sent to Gemini has no bounded array above the limit the live service accepted', () => {
    expect(largestBoundedArray(VISION_RESPONSE_JSON_SCHEMA as unknown as Json)).toBeLessThanOrEqual(OBSERVED_LIMIT);
  });
  it('the request the employee made now passes the (simulated) live check, and the candidate rows reach validation', async () => {
    const raw = await geminiVision(document, signal());
    expect(JSON.parse(raw).candidates).toHaveLength(3);
    const sent = (generateContent.mock.calls[0] as unknown as [{ config: { responseJsonSchema: typeof VISION_RESPONSE_JSON_SCHEMA } }])[0];
    expect(sent.config.responseJsonSchema).toBe(VISION_RESPONSE_JSON_SCHEMA);
    expect(sent.config.responseJsonSchema.properties.candidates.items.required).toEqual(['field', 'label_text', 'value_text', 'section', 'period']);
  });
  it('the failing condition itself: a bounded candidate array (40) is refused with Google\'s 400, shown as vision_rejected, nothing invented', async () => {
    const bounded = JSON.parse(JSON.stringify(VISION_RESPONSE_JSON_SCHEMA));
    bounded.properties.candidates.maxItems = 40;
    const call: VisionCall = async (_document, abort) => {
      try { await generateContent({ config: { responseJsonSchema: bounded } }); return ''; }
      catch (error) { if (abort.aborted) throw error; const { classifyVisionError } = await import('../src/lib/payslip/payslip-vision'); throw classifyVisionError(error); }
    };
    await expect(readWithVision(document, call, { sleep: async () => {} })).rejects.toMatchObject({ reason: 'rejected',
      diagnostic: { stage: 'request', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT', attempts: 1 } });
    // A 400 is not retried: the same document is sent to Google once.
    expect(generateContent).toHaveBeenCalledTimes(1);
    const bytes = new Uint8Array(readFileSync('tests/fixtures/payslips/complex-rtl.png'));
    const work = extractPayslip({ bytes, userId: '0b6c1d0e-4a59-4a3c-9f0f-6a1f2d9e7a11', conversationId: '6f1d2c3b-8e7a-4b5c-9d0e-1f2a3b4c5d6e', consent: true },
      { vision: call, visionEnabled: () => true, visionOptions: { sleep: async () => {} } });
    await expect(work).rejects.toBeInstanceOf(PayslipError);
    await expect(work).rejects.toMatchObject({ code: 'vision_rejected' });
  });
  it('the server still enforces the candidate limit: more rows than allowed fail visibly, never truncated', async () => {
    const tooMany = { ...validResponse, candidates: Array.from({ length: VISION_MAX_CANDIDATES + 1 }, () => validResponse.candidates[0]) };
    await expect(readWithVision(document, async () => JSON.stringify(tooMany), { sleep: async () => {} }))
      .rejects.toMatchObject({ reason: 'invalid_output', diagnostic: { stage: 'validate' } });
  });
  it('a schema-related rejection message is classified for the log (fixed category, no upstream text)', () => {
    expect(geminiDiagnostic(Object.assign(new Error('{"error":{"code":400,"message":"The specified schema produces a constraint that has too many states for serving.","status":"INVALID_ARGUMENT"}}'), { status: 400 })))
      .toMatchObject({ googleStatus: 'INVALID_ARGUMENT', detail: 'response_schema' });
    // Google's generic text (as in the live failure) stays unclassified rather than guessed.
    expect(geminiDiagnostic(Object.assign(new Error(GOOGLE_400), { status: 400 }))).toMatchObject({ googleStatus: 'INVALID_ARGUMENT', detail: 'unclassified' });
  });
});
