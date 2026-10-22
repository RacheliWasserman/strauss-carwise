import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ profile: vi.fn(), conversation: vi.fn(), generateContent: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/lib/conversation-repository', () => ({ getConversation: mocks.conversation }));
vi.mock('@google/genai', () => ({ GoogleGenAI: vi.fn(() => ({ models: { generateContent: mocks.generateContent } })) }));

import { POST } from '../src/app/api/conversations/[conversationId]/payslip/route';
import { extractPayslip } from '../src/lib/payslip/payslip-service';
import { parsePayslipLines, reverseWordOrder, tokens } from '../src/lib/payslip/payslip-parser';
import { fieldsFromVision, type VisionResponse } from '../src/lib/payslip/payslip-vision';
import { applyPayslipReview } from '../src/lib/payslip/payslip-handoff';
import { decodePayslipReview, encodePayslipReview, extractionResponseSchema, PAYSLIP_FIELD_ORDER, VISION_CONSENT_VERSION, type ExtractedField, type PayslipField } from '../src/lib/payslip/payslip-contract';
import { buildPayslipReview, initialReviewRows, reviewRowState, type ExtractedResult } from '../src/lib/payslip/payslip-review-form';
import { PayslipReviewRow } from '../src/components/chat/payslip-review-row';
import type { AdvisorState } from '../src/lib/ai/advisor-state';
import type { DocumentLine } from '../src/lib/payslip/payslip-file';

/**
 * Golden regression for the synthetic complex payslip (dense RTL layout, payments beside deductions, a contributions
 * table with employee and employer columns, cumulative figures and leave balances). PDF tests read the actual
 * fixture bytes locally. Image tests use DETERMINISTIC MOCKED Gemini output: they test our validation of a
 * transcription, not that live Gemini reads this image correctly.
 */
type Golden = { value: number; label: string; printed: string; page: number };
const GOLDEN = JSON.parse(readFileSync('tests/fixtures/payslips/complex-golden.json', 'utf8')).fields as Record<PayslipField, Golden>;
const GOLDEN_VALUES = Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, GOLDEN[field].value]));
process.env.SUPABASE_SECRET_KEY ||= 'test-only-secret';
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/payslips/${name}`));
const values = (fields: ExtractedField[]) => Object.fromEntries(fields.map(item => [item.field, item.value]));
const byField = (fields: ExtractedField[]) => Object.fromEntries(fields.map(item => [item.field, item])) as Record<PayslipField, ExtractedField>;
let userId: string;
const conversationId = randomUUID();
const extract = (name: string, consent = false) => extractPayslip({ bytes: fixture(name), userId, conversationId, consent },
  { vision: async () => JSON.stringify(transcription()), visionEnabled: () => true });
const extracted = async (name: string, consent = false) => {
  const result = await extract(name, consent);
  if (result.status !== 'extracted') throw new Error(`Expected an extraction, got ${result.status}`);
  return result;
};

/** A faithful transcription of complex-rtl.png, as Gemini is asked to return it. */
const transcription = (labels: Partial<Record<PayslipField, string>> = {}): VisionResponse => ({ is_payslip: true, legibility: 'good', candidates: [
  { field: 'base_salary', label_text: labels.base_salary ?? 'שכר יסוד', value_text: '18,500.00', normalized_value: 18500, unit: 'currency', column: 'not_applicable', period: 'current_month', page: 1 },
  { field: 'commissions', label_text: labels.commissions ?? 'עמלות מכירה חודשיות', value_text: '2,300.00', normalized_value: 2300, unit: 'currency', period: 'current_month', page: 1 },
  { field: 'bonus', label_text: labels.bonus ?? 'בונוס חודשי קבוע', value_text: '1,000.00', normalized_value: 1000, unit: 'currency', recurrence: 'recurring', period: 'current_month', page: 1 },
  { field: 'employee_pension_percent', label_text: labels.employee_pension_percent ?? 'קרן פנסיה · עובד %', value_text: '6.00', normalized_value: 6, unit: 'percent', column: 'employee', period: 'current_month', page: 1 },
  { field: 'employee_study_fund_percent', label_text: labels.employee_study_fund_percent ?? 'קרן השתלמות · עובד %', value_text: '2.50', normalized_value: 2.5, unit: 'percent', column: 'employee', period: 'current_month', page: 1 },
  { field: 'tax_credit_points', label_text: labels.tax_credit_points ?? 'נקודות זיכוי במס', value_text: '2.75', normalized_value: 2.75, unit: 'number', period: 'current_month', page: 1 },
  { field: 'current_participation', label_text: labels.current_participation ?? 'השתתפות עובד ברכב', value_text: '350.00', normalized_value: 350, unit: 'currency', period: 'current_month', page: 1 }] });
const vision = (fields: VisionResponse['candidates'], legibility: VisionResponse['legibility'] = 'good') => byField(fieldsFromVision({ is_payslip: true, legibility, candidates: fields }));
const lines = (...rows: Array<string[] | { page: number; cells: Array<string | { text: string; x: number }> }>): DocumentLine[] =>
  rows.map(row => Array.isArray(row) ? { page: 1, cells: row.map(text => ({ text })) }
    : { page: row.page, cells: row.cells.map(cell => typeof cell === 'string' ? { text: cell } : cell) }) as DocumentLine[];
const parsed = (...rows: Parameters<typeof lines>) => byField(parsePayslipLines(lines(...rows)).fields);

beforeEach(() => {
  vi.resetAllMocks();
  userId = randomUUID();
  mocks.profile.mockResolvedValue({ userId, role: 'employee' });
  mocks.conversation.mockImplementation(async (id: string) => ({ id, owner_user_id: userId }));
  mocks.generateContent.mockResolvedValue({ text: JSON.stringify(transcription()), candidates: [{ finishReason: 'STOP' }] });
  vi.spyOn(console, 'info').mockImplementation(() => {});vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete process.env.PAYSLIP_VISION_ENABLED; });

describe('A. digital PDF: the actual fixture bytes, read locally', () => {
  it('complex-rtl.pdf yields all seven golden values with their printed labels, without visual reading', async () => {
    const result = await extracted('complex-rtl.pdf');
    expect(result.method).toBe('pdf_text');expect(result.warnings).toEqual([]);
    expect(values(result.fields)).toEqual(GOLDEN_VALUES);
    const fields = byField(result.fields);
    for (const field of PAYSLIP_FIELD_ORDER) {
      expect(fields[field].evidence).toContain(GOLDEN[field].label);expect(fields[field].page).toBe(GOLDEN[field].page);
    }
    expect(fields.base_salary.evidence).toBe('שכר יסוד · 18,500.00');
    expect(fields.current_participation.evidence).toBe('השתתפות עובד ברכב · 350.00');
    // Clear values are "found", including the bonus: its label prints that it is monthly and fixed.
    expect(PAYSLIP_FIELD_ORDER.filter(field => fields[field].confidence === 'review')).toEqual([]);
  });

  it('complex-reversed.pdf (words stored in reverse order) is repaired to the same values, all for review', async () => {
    const result = await extracted('complex-reversed.pdf');
    expect(result.method).toBe('pdf_text');
    expect(values(result.fields)).toEqual(GOLDEN_VALUES);
    expect(result.warnings.join()).toContain('סדר המילים');
    const fields = byField(result.fields);
    expect(fields.base_salary.evidence).toBe('שכר יסוד · 18,500.00');
    expect(fields.tax_credit_points.evidence).toBe('נקודות זיכוי במס · 2.75');
    expect(fields.current_participation.evidence).toBe('השתתפות עובד ברכב · 350.00');
    expect(result.fields.every(item => item.confidence === 'review')).toBe(true);
  });
});

describe('B. image: mocked Gemini transcription through the real validation (not proof that live Gemini reads it)', () => {
  it.each(['complex-rtl.png', 'complex-reversed.png'])('%s is never sent without consent', async name => {
    expect(await extract(name)).toEqual({ status: 'needs_vision', reason: 'image', visionAvailable: true });
  });
  it('a faithful transcription of complex-rtl.png gives the golden values, clear ones as found', async () => {
    const result = await extracted('complex-rtl.png', true);
    expect(result.method).toBe('vision');expect(values(result.fields)).toEqual(GOLDEN_VALUES);
    const fields = byField(result.fields);
    expect(PAYSLIP_FIELD_ORDER.filter(field => fields[field].confidence === 'review')).toEqual([]);
    expect(fields.tax_credit_points.evidence).toBe('נקודות זיכוי במס · 2.75');
  });
  it('labels transcribed in the reversed print order of complex-reversed.png are repaired, for review', () => {
    const fields = byField(fieldsFromVision(transcription({ base_salary: 'יסוד שכר', tax_credit_points: 'במס זיכוי נקודות', current_participation: 'ברכב עובד השתתפות' })));
    expect(values(Object.values(fields))).toEqual(GOLDEN_VALUES);
    for (const field of ['base_salary', 'tax_credit_points', 'current_participation'] as const) {
      expect(fields[field]).toMatchObject({ confidence: 'review', evidence: `${GOLDEN[field].label} · ${GOLDEN[field].printed}` });
    }
  });
  it('a confused model is not believed: every distractor on this payslip is refused', () => {
    const fields = vision([
      { field: 'base_salary', label_text: 'ברוטו חייב מס כולל שווי רכב', value_text: '31,350.00', unit: 'currency' },
      { field: 'commissions', label_text: 'שכר חייב מצטבר', value_text: '193,420.00', unit: 'currency' },
      { field: 'bonus', label_text: 'מענק חד־פעמי', value_text: '3,500.00', unit: 'currency', recurrence: 'one_time' },
      { field: 'employee_pension_percent', label_text: 'קרן פנסיה · מעסיק %', value_text: '6.50', unit: 'percent', column: 'employer' },
      { field: 'employee_study_fund_percent', label_text: 'קרן השתלמות — עובד 2.5%', value_text: '462.50', unit: 'currency', column: 'employee' },
      { field: 'tax_credit_points', label_text: 'הבראה', value_text: '2.92', unit: 'number' },
      { field: 'current_participation', label_text: 'שווי שימוש ברכב — למס בלבד', value_text: '3,100.00', unit: 'currency' }]);
    expect(values(Object.values(fields))).toEqual(Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, null])));
    for (const [label, value] of [['גילום מס רכב — למס בלבד', '0.00'], ['ניכויים כולל רכב', '8,752.50'], ['זקיפת רכב', '3,100.00'], ['השתתפות בדלק', '200.00']]) {
      expect(vision([{ field: 'current_participation', label_text: label, value_text: value, unit: 'currency' }]).current_participation.value).toBeNull();
    }
    for (const label of ['שעות נוספות 125%', 'תוספת משמרת', 'החזר הוצאות נסיעה', 'סך תשלומי מזומן', 'נטו לתשלום']) {
      expect(vision([{ field: 'base_salary', label_text: label, value_text: '1,750.00', unit: 'currency' }]).base_salary.value).toBeNull();
    }
    for (const label of ['חופשה', 'מחלה', 'יתרת הבראה']) {
      expect(vision([{ field: 'tax_credit_points', label_text: label, value_text: '2.92', unit: 'number' }]).tax_credit_points.value).toBeNull();
    }
  });
  it('a cumulative period, two different rows for one field, or a disagreeing normalized number gives no value', () => {
    expect(vision([{ field: 'commissions', label_text: 'עמלות מכירה חודשיות', value_text: '13,800.00', unit: 'currency', period: 'cumulative' }]).commissions.value).toBeNull();
    const ambiguous = vision([{ field: 'base_salary', label_text: 'שכר יסוד', value_text: '18,500.00', unit: 'currency' },
      { field: 'base_salary', label_text: 'שכר בסיס', value_text: '19,000.00', unit: 'currency' }]).base_salary;
    expect(ambiguous).toMatchObject({ value: null, ambiguous: true });
    const mismatch = vision([{ field: 'base_salary', label_text: 'שכר יסוד', value_text: '18,500.00', normalized_value: 1850, unit: 'currency' }]).base_salary;
    expect(mismatch).toMatchObject({ value: null, ambiguous: true });
    expect(vision([{ field: 'base_salary', label_text: 'שכר יסוד', value_text: '18,500.00', unit: 'currency', period: 'unclear' }]).base_salary)
      .toMatchObject({ value: 18500, confidence: 'review' });
    expect(vision([{ field: 'base_salary', value_text: '18,500.00', unit: 'currency' }]).base_salary).toMatchObject({ value: 18500, confidence: 'review' });
  });
});

describe('C. normalization of RTL labels, punctuation, abbreviations and numbers', () => {
  it('restores reversed word order and mirrored parentheses, and leaves amounts alone', () => {
    expect(reverseWordOrder('יסוד שכר')).toBe('שכר יסוד');
    expect(reverseWordOrder('6% עובד - פנסיה')).toBe('פנסיה - עובד 6%');
    expect(reverseWordOrder(')פטור( נסיעה הוצאות החזר')).toBe('החזר הוצאות נסיעה (פטור)');
    expect(reverseWordOrder('18,500.00')).toBe('18,500.00');
  });
  it('reads printed number formats', () => {
    expect(tokens('18,500.00')[0]).toMatchObject({ value: 18500, percent: false });
    expect(tokens('₪ 350.00')[0].value).toBe(350);expect(tokens('350.00-')[0].value).toBe(350);
    expect(tokens('6.00%')[0]).toMatchObject({ value: 6, percent: true });expect(tokens('%2.5')[0]).toMatchObject({ value: 2.5, percent: true });
  });
  it('recognizes credit-point abbreviations in the text reader and visual reading', () => {
    for (const label of ['נ״ז', 'נ"ז', 'נ.ז']) {
      expect(parsed([label, '2.75']).tax_credit_points).toMatchObject({ value: 2.75, confidence: 'review' });
      expect(vision([{ field: 'tax_credit_points', label_text: label, value_text: '2.75', unit: 'number' }]).tax_credit_points.value).toBe(2.75);
    }
    expect(parsed(['נק׳ זיכוי', '2.75']).tax_credit_points).toMatchObject({ value: 2.75, confidence: 'high' });
  });
});

describe('D. current month versus cumulative', () => {
  it('the fixture\'s cumulative rows (193,420 / 25,700) and balances never become a field', async () => {
    const all = Object.values(values((await extracted('complex-rtl.pdf')).fields));
    for (const distractor of [193420, 25700, 12.5, 18.75, 2.92, 28670, 31350, 8752.5, 19917.5]) expect(all).not.toContain(distractor);
  });
  it('a year-to-date column is skipped, by position (DOCX) and by x (PDF)', () => {
    expect(parsed(['תיאור', 'סכום', 'מצטבר מתחילת שנה'], ['עמלות מכירה', '2,300.00', '13,800.00']).commissions.value).toBe(2300);
    expect(parsed({ page: 1, cells: [{ text: 'תיאור', x: 500 }, { text: 'החודש', x: 300 }, { text: 'מצטבר', x: 100 }] },
      { page: 1, cells: [{ text: 'שכר יסוד', x: 500 }, { text: '18,500.00', x: 300 }, { text: '129,500.00', x: 100 }] }).base_salary.value).toBe(18500);
    // Without such a header the amount is still the row's last number (quantity, rate, amount).
    expect(parsed(['שכר יסוד', '1.00', '18,500.00']).base_salary.value).toBe(18500);
  });
  it('a cumulative row beside the monthly row is ignored instead of making the field ambiguous', () => {
    const fields = parsed(['עמלות מכירה חודשיות', '2,300.00'], ['עמלות מצטבר', '13,800.00'], ['נקודות זיכוי במס', '2.75'], ['נקודות זיכוי מצטבר', '16.50']);
    expect(fields.commissions).toMatchObject({ value: 2300, confidence: 'high' });expect(fields.tax_credit_points.value).toBe(2.75);
  });
  it('a value on page 2 is found with its page', () => {
    const fields = parsed({ page: 1, cells: ['שכר יסוד', '18,500.00'] }, { page: 2, cells: ['השתתפות עובד ברכב', '350.00'] });
    expect(fields.current_participation).toMatchObject({ value: 350, page: 2 });
  });
});

describe('E. employee versus employer, percentage versus amount', () => {
  it('the contributions table gives the employee % (6.00 / 2.50), never employer 6.50 / 7.50, severance or the ₪ deduction', async () => {
    const fields = byField((await extracted('complex-rtl.pdf')).fields);
    expect(fields.employee_pension_percent).toMatchObject({ value: 6, evidence: 'קרן פנסיה (עובד) · 6.00%' });
    expect(fields.employee_study_fund_percent).toMatchObject({ value: 2.5, evidence: 'קרן השתלמות (עובד) · 2.50%' });
  });
  it('amount-only or employer-only rows give no percentage, and no default rate is ever filled', () => {
    const fields = parsed(['פנסיה עובד', '1,110.00'], ['קרן השתלמות מעסיק 7.5%', '1,387.50']);
    expect(fields.employee_pension_percent.value).toBeNull();expect(fields.employee_pension_percent.warnings.join()).toContain('לא חישבתי');
    expect(fields.employee_study_fund_percent.value).toBeNull();
  });
});

describe('F. ambiguity is reported, not resolved by guessing', () => {
  it('two different base salaries or credit values give no value and an "ambiguous" state', async () => {
    const two = parsed(['שכר יסוד', '18,500.00'], ['שכר יסוד', '19,000.00']).base_salary;
    expect(two).toMatchObject({ value: null, ambiguous: true });
    expect(parsed(['נקודות זיכוי', '2.75', '2.92']).tax_credit_points).toMatchObject({ value: null, ambiguous: true });
    // A field that is simply not printed is "missing", not ambiguous.
    expect(parsed(['שכר יסוד', '18,500.00']).commissions.ambiguous).toBeUndefined();
  });
  it('a "שכר משולב" base salary is suggested for review only', () => {
    expect(parsed(['שכר משולב', '18,500.00']).base_salary).toMatchObject({ value: 18500, confidence: 'review' });
  });
  it('only 0 printed beside the field\'s own label is a zero; a filler zero is not', () => {
    expect(vision([{ field: 'current_participation', label_text: 'השתתפות עובד ברכב', value_text: '0.00', unit: 'currency' }]).current_participation.value).toBe(0);
    expect(vision([{ field: 'current_participation', value_text: '0' }]).current_participation.value).toBeNull();
  });
});

describe('G. API → review form → reviewed message (explicit approval kept)', () => {
  const post = (name: string, consent = false) => {
    const form = new FormData();
    form.append('file', new Blob([fixture(name) as unknown as BlobPart]), name);
    if (consent) form.append('consent', VISION_CONSENT_VERSION);
    return POST(new Request(`http://localhost/api/conversations/${conversationId}/payslip`, { method: 'POST', body: form }), { params: Promise.resolve({ conversationId }) });
  };
  const asClient = async (response: Response) => {
    const parsedResponse = extractionResponseSchema.parse(await response.json());
    if (parsedResponse.status !== 'extracted') throw new Error('Expected an extraction');
    return parsedResponse as ExtractedResult;
  };
  const render = (result: ExtractedResult, field: PayslipField, rows = initialReviewRows(result)) => {
    vi.stubGlobal('React', React);
    return renderToStaticMarkup(React.createElement(PayslipReviewRow, { field, result, row: rows[field], onChange: () => {} }));
  };

  it.each([['complex-rtl.pdf', false], ['complex-rtl.png', true]] as const)('%s: editable numbers, then pending values that still need approval', async (name, consent) => {
    if (consent) { process.env.PAYSLIP_VISION_ENABLED = 'true';process.env.GEMINI_API_KEY ||= 'test-key-not-real'; }
    const result = await asClient(await post(name, consent));
    const rows = initialReviewRows(result);
    expect(Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, rows[field].input])))
      .toEqual({ base_salary: '18500', commissions: '2300', bonus: '1000', employee_pension_percent: '6', employee_study_fund_percent: '2.5', tax_credit_points: '2.75', current_participation: '350' });
    expect(reviewRowState(result, 'base_salary', rows.base_salary)).toBe('found');expect(reviewRowState(result, 'bonus', rows.bonus)).toBe('found');
    const html = render(result, 'base_salary');
    expect(html).toContain('value="18500"');expect(html).toContain('זוהה בתלוש');expect(html).toMatch(/הערך שנקרא: <bdi dir="ltr">18,500 ₪<\/bdi>/);
    expect(render(result, 'bonus')).toContain('זוהה בתלוש');

    const review = decodePayslipReview(encodePayslipReview(buildPayslipReview(result, rows)!))!;
    const state = { userId, conversationId, pendingFacts: [], unknownFacts: [] } as unknown as AdvisorState;
    expect(applyPayslipReview(state, review, randomUUID())).toMatchObject({ provenance: 'valid', accepted: 7 });
    expect(state.pendingFacts.map(fact => [fact.field, fact.value, fact.source, fact.status]))
      .toEqual(PAYSLIP_FIELD_ORDER.map(field => [field, GOLDEN[field].value, 'payslip', 'pending_confirmation']));
    // Nothing is approved or saved by the upload: approval still happens only through the summary.
    expect((state as Partial<AdvisorState>).pendingApproval).toBeUndefined();expect((state as Partial<AdvisorState>).confirmedVersion).toBeUndefined();
  });

  it('missing and ambiguous rows render their own states and stay empty', () => {
    const result = { status: 'extracted', method: 'pdf_text', warnings: [], token: 'a'.repeat(64), expiresAt: new Date().toISOString(), fields: parsePayslipLines(lines(
      ['שכר יסוד', '18,500.00'], ['שכר יסוד', '19,000.00'], ['עמלות מכירה', '2,300.00'])).fields } as ExtractedResult;
    const rows = initialReviewRows(result);
    expect(rows.base_salary.input).toBe('');expect(rows.bonus.input).toBe('');
    expect(render(result, 'base_salary')).toContain('לא ניתן לקבוע בוודאות');
    expect(render(result, 'bonus')).toContain('לא נמצא בתלוש');
  });
});
