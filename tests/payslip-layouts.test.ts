import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { extractPayslip } from '../src/lib/payslip/payslip-service';
import { parsePayslipLines } from '../src/lib/payslip/payslip-parser';
import { bonusRecurrence, tokens } from '../src/lib/payslip/payslip-rules';
import { fieldsFromVision, type VisionResponse } from '../src/lib/payslip/payslip-vision';
import { extractionResponseSchema, PAYSLIP_FIELD_ORDER, type ExtractedField, type PayslipField } from '../src/lib/payslip/payslip-contract';
import { initialReviewRows, reviewRowState, type ExtractedResult } from '../src/lib/payslip/payslip-review-form';
import type { DocumentLine } from '../src/lib/payslip/payslip-file';

/**
 * Robustness across materially different layouts (cards, YTD tables with English labels, multi-page, conflicting
 * evidence), each checked against a golden record of values AND review states, so abstention is asserted as strictly
 * as extraction. PDF tests read the actual fixture bytes. Image tests use DETERMINISTIC MOCKED Gemini candidate rows
 * that model a faithful transcription under the current prompt: they test our validation, not live Gemini.
 */
type Golden = { value: number | null; state: string; label?: string; page?: number };
const GOLDEN = JSON.parse(readFileSync('tests/fixtures/payslips/layout-golden.json', 'utf8')) as Record<string, { fields: Record<PayslipField, Golden> }>;
process.env.SUPABASE_SECRET_KEY ||= 'test-only-secret';
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/payslips/${name}`));
const userId = randomUUID();
const conversationId = randomUUID();
type Candidates = VisionResponse['candidates'];
const extract = async (name: string, candidates?: Candidates, legibility: VisionResponse['legibility'] = 'good') => {
  const result = await extractPayslip({ bytes: fixture(name), userId, conversationId, consent: Boolean(candidates) },
    { vision: async () => JSON.stringify({ is_payslip: true, legibility, candidates: candidates ?? [] }), visionEnabled: () => true });
  // As the browser receives it.
  const parsed = extractionResponseSchema.parse(JSON.parse(JSON.stringify(result)));
  if (parsed.status !== 'extracted') throw new Error(`Expected an extraction, got ${parsed.status}`);
  return parsed as ExtractedResult;
};
const byField = (fields: ExtractedField[]) => Object.fromEntries(fields.map(item => [item.field, item])) as Record<PayslipField, ExtractedField>;
/** Value and review state per field, exactly as the review form shows them. */
const outcome = (result: ExtractedResult) => {
  const rows = initialReviewRows(result);
  return Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, { value: byField(result.fields)[field].value, state: reviewRowState(result, field, rows[field]) }]));
};
const expected = (layout: string) => Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, { value: GOLDEN[layout].fields[field].value, state: GOLDEN[layout].fields[field].state }]));
const lines = (...rows: Array<string[] | { page: number; cells: Array<string | { text: string; x: number }> }>): DocumentLine[] =>
  rows.map(row => Array.isArray(row) ? { page: 1, cells: row.map(text => ({ text })) }
    : { page: row.page, cells: row.cells.map(cell => typeof cell === 'string' ? { text: cell } : cell) }) as DocumentLine[];
const parsed = (...rows: Parameters<typeof lines>) => byField(parsePayslipLines(lines(...rows)).fields);
const row = (field: PayslipField, label: string, value: string, extra: Partial<Candidates[number]> = {}): Candidates[number] =>
  ({ field, label_text: label, value_text: value, period: 'current_month', page: 1, ...extra });

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('digital PDFs of different layouts (actual fixture bytes, read locally)', () => {
  it.each(['layout-cards', 'layout-ytd', 'layout-multipage', 'layout-conflicts'])('%s matches its golden values and review states', async layout => {
    const result = await extract(`${layout}.pdf`);
    expect(result.method).toBe('pdf_text');
    expect(outcome(result)).toEqual(expected(layout));
    const fields = byField(result.fields);
    for (const field of PAYSLIP_FIELD_ORDER) {
      const golden = GOLDEN[layout].fields[field];
      if (golden.label) expect(fields[field].evidence).toContain(golden.label);
      if (golden.page) expect(fields[field].page).toBe(golden.page);
      // Never a silent zero: no field is 0 unless a 0 is printed for it (none of these layouts prints one).
      expect(fields[field].value).not.toBe(0);
    }
  });

  it('layout-cards: label-above-value pairs are found, but only ever suggested for review', async () => {
    const fields = byField((await extract('layout-cards.pdf')).fields);
    expect(fields.base_salary.warnings.join()).toContain('מתחת לתווית');
    // The one-time holiday grant (1,500) and the car imputation (2,900) are not taken.
    expect(Object.values(fields).map(item => item.value)).not.toContain(1500);expect(Object.values(fields).map(item => item.value)).not.toContain(2900);
  });
  it('layout-ytd: the year-to-date column, the retro difference and the car benefit are never values; abstentions explain why', async () => {
    const fields = byField((await extract('layout-ytd.pdf')).fields);
    for (const distractor of [36000, 3100, 400, 2700, 720]) expect(Object.values(fields).map(item => item.value)).not.toContain(distractor);
    expect(fields.employee_pension_percent.warnings.join()).toContain('לא חישבתי');
    expect(fields.current_participation.warnings.join()).toContain('שווי שימוש');
    expect(fields.bonus.warnings.join()).toContain('לא כתוב בתלוש שהבונוס קבוע');
  });
  it('layout-multipage: the annual bonus, severance, the credit-point value in ₪ and the title\'s page number are ignored', async () => {
    const fields = byField((await extract('layout-multipage.pdf')).fields);
    expect(fields.bonus).toMatchObject({ value: 2000, confidence: 'high' });
    expect(fields.employee_pension_percent.value).toBe(7);expect(fields.tax_credit_points.value).toBe(2.75);
  });
  it('layout-conflicts: nothing is guessed, and the review screen is still shown so the employee decides', async () => {
    const result = await extract('layout-conflicts.pdf');
    expect(result.fields.every(item => item.value === null)).toBe(true);
    const fields = byField(result.fields);
    expect(fields.base_salary.warnings.join()).toContain('9,500');expect(fields.bonus.warnings.join()).toContain('חד־פעמי');
    expect(fields.employee_pension_percent.warnings.join()).toContain('המעביד');
  });
});

describe('images and scans: mocked Gemini candidate rows through the real validation', () => {
  it.each(['layout-cards.png', 'layout-ytd-photo.jpg'])('%s is never sent without consent', async name => {
    const result = await extractPayslip({ bytes: fixture(name), userId, conversationId, consent: false }, { vision: vi.fn(), visionEnabled: () => true });
    expect(result).toEqual({ status: 'needs_vision', reason: 'image', visionAvailable: true });
  });
  it('a scan without a text layer is offered visual reading', async () => {
    const result = await extractPayslip({ bytes: fixture('layout-conflicts-scanned.pdf'), userId, conversationId, consent: false }, { visionEnabled: () => true });
    expect(result).toEqual({ status: 'needs_vision', reason: 'scanned_pdf', visionAvailable: true });
  });

  it('layout-cards.png: near-misses listed beside the real rows (grant, employer %, imputation) do not hide them', async () => {
    const result = await extract('layout-cards.png', [
      row('base_salary', 'משכורת בסיס', '14,200.00', { section: 'earnings', unit: 'currency', normalized_value: 14200 }),
      row('commissions', 'עמלת מכירות', '1,850.00', { section: 'earnings', unit: 'currency' }),
      row('bonus', 'מענק חג', '1,500.00', { section: 'earnings', unit: 'currency', recurrence: 'one_time' }),
      row('bonus', 'פרמיה חודשית קבועה', '800.00', { section: 'earnings', unit: 'currency', recurrence: 'recurring' }),
      row('employee_pension_percent', 'הפרשת מעסיק לפנסיה', '7%', { section: 'contributions_table', unit: 'percent', column: 'employer' }),
      row('employee_pension_percent', 'הפרשת עובד לפנסיה', '6.5%', { section: 'contributions_table', unit: 'percent', column: 'employee' }),
      row('employee_study_fund_percent', 'קרן השתלמות עובד', '2.5%', { section: 'contributions_table', unit: 'percent', column: 'employee' }),
      row('tax_credit_points', 'נ"ז', '2.25', { section: 'tax_details', unit: 'number' }),
      row('tax_credit_points', 'יתרת חופשה', '9.5', { section: 'balances', unit: 'number' }),
      row('current_participation', 'זקיפת שווי רכב', '2,900.00', { section: 'earnings', unit: 'currency' }),
      row('current_participation', 'ניכוי רכב', '600.00', { section: 'deductions', unit: 'currency' })]);
    expect(outcome(result)).toEqual({ base_salary: { value: 14200, state: 'found' }, commissions: { value: 1850, state: 'found' },
      bonus: { value: 800, state: 'found' }, employee_pension_percent: { value: 6.5, state: 'found' }, employee_study_fund_percent: { value: 2.5, state: 'found' },
      tax_credit_points: { value: 2.25, state: 'review' }, current_participation: { value: 600, state: 'found' } });
  });

  it('layout-ytd-photo.jpg: cumulative values, retro differences, amount-only pension and the car benefit are refused', async () => {
    const result = await extract('layout-ytd-photo.jpg', [
      row('base_salary', 'שכר בסיס / Base salary', '12,000.00', { section: 'earnings', unit: 'currency', normalized_value: 12000 }),
      row('base_salary', 'שכר בסיס / Base salary', '36,000.00', { section: 'earnings', unit: 'currency', period: 'cumulative' }),
      row('base_salary', 'הפרשי שכר בסיס (רטרו)', '400.00', { section: 'earnings', unit: 'currency' }),
      row('commissions', 'Commission עמלות', '950.00', { section: 'earnings', unit: 'currency' }),
      row('commissions', 'Commission עמלות', '3,100.00', { section: 'earnings', unit: 'currency', period: 'cumulative' }),
      row('bonus', 'Bonus בונוס', '1,200.00', { section: 'earnings', unit: 'currency', recurrence: 'unclear' }),
      row('employee_pension_percent', 'Pension employee פנסיה עובד', '720.00', { section: 'deductions', unit: 'currency', column: 'employee' }),
      row('employee_study_fund_percent', 'קרן השתלמות', '2.50%', { section: 'contributions_table', unit: 'percent', column: 'employee' }),
      row('employee_study_fund_percent', 'קרן השתלמות', '7.50%', { section: 'contributions_table', unit: 'percent', column: 'employer' }),
      row('current_participation', 'שווי שימוש ברכב Car benefit', '2,700.00', { section: 'earnings', unit: 'currency' })]);
    expect(outcome(result)).toEqual(expected('layout-ytd'));
  });

  it('layout-conflicts-scanned.pdf: conflicting rows are shown as "cannot determine", nothing is chosen', async () => {
    const result = await extract('layout-conflicts-scanned.pdf', [
      row('base_salary', 'שכר בסיס', '9,000.00', { section: 'earnings', unit: 'currency' }),
      row('base_salary', 'שכר בסיס לפי הסכם', '9,500.00', { section: 'other', unit: 'currency' }),
      row('commissions', 'עמלות מצטבר', '4,000.00', { section: 'other', unit: 'currency', period: 'cumulative' }),
      row('bonus', 'מענק חד פעמי', '2,000.00', { section: 'earnings', unit: 'currency', recurrence: 'one_time' }),
      row('employee_pension_percent', 'הפרשת מעביד לפנסיה', '6.5%', { section: 'contributions_table', unit: 'percent', column: 'employer' }),
      row('tax_credit_points', 'נקודות זיכוי', '2.25', { section: 'tax_details', unit: 'number' }),
      row('tax_credit_points', 'נקודות זיכוי', '2.75', { section: 'tax_details', unit: 'number' }),
      row('current_participation', 'שווי רכב', '2,400.00', { section: 'earnings', unit: 'currency' })], 'partial');
    expect(outcome(result)).toEqual(expected('layout-conflicts'));
  });
});

describe('LIVE REGRESSION (2026-10-21): the recurring bonus beside a one-time grant', () => {
  const grant = row('bonus', 'מענק חד־פעמי', '3,500.00', { section: 'earnings', unit: 'currency', recurrence: 'one_time' });
  const monthly = row('bonus', 'בונוס חודשי קבוע', '1,000.00', { section: 'earnings', unit: 'currency', recurrence: 'recurring' });
  const bonus = (candidates: Candidates) => byField(fieldsFromVision({ is_payslip: true, legibility: 'good', candidates })).bonus;
  it('with both rows transcribed, the recurring bonus is found whatever their order', () => {
    expect(bonus([grant, monthly])).toMatchObject({ value: 1000, confidence: 'high', evidence: 'בונוס חודשי קבוע · 1,000.00' });
    expect(bonus([monthly, grant])).toMatchObject({ value: 1000, confidence: 'high' });
  });
  it('the observed live output (only the grant, as the old one-row-per-field contract forced) gives no value and says why', () => {
    const result = bonus([grant]);
    expect(result.value).toBeNull();expect(result.ambiguous).toBeUndefined();expect(result.warnings.join()).toContain('3,500');
  });
  it('the model\'s "recurring" claim alone does not establish recurrence; printed words decide', () => {
    expect(bonus([row('bonus', 'בונוס', '1,000.00', { recurrence: 'recurring' })])).toMatchObject({ value: 1000, confidence: 'review' });
    expect(bonus([row('bonus', 'בונוס שנתי', '1,000.00', { recurrence: 'recurring' })]).value).toBeNull();
    expect(bonus([row('bonus', 'פרמיה', '700.00', { recurrence: 'one_time' })]).value).toBeNull();
  });
  it('two different recurring bonuses are not added up or chosen between', () => {
    expect(bonus([monthly, row('bonus', 'פרמיה קבועה', '500.00', { recurrence: 'recurring' })])).toMatchObject({ value: null, ambiguous: true });
  });
  it('the text reader applies the same rule to a grant and a recurring bonus on separate rows', () => {
    expect(parsed(['מענק חד־פעמי', '3,500.00'], ['בונוס חודשי קבוע', '1,000.00']).bonus).toMatchObject({ value: 1000, confidence: 'high' });
    expect(parsed(['מענק', '3,500.00'], ['בונוס', '1,000.00']).bonus).toMatchObject({ value: 1000, confidence: 'review' });
  });
});

describe('general rules (no fixture involved)', () => {
  it('recurrence comes from printed words, in Hebrew and English', () => {
    for (const label of ['בונוס חודשי', 'פרמיה קבועה', 'תמריץ שוטף', 'Monthly bonus', 'Fixed premium']) expect(bonusRecurrence(label)).toBe('recurring');
    for (const label of ['מענק חג', 'בונוס שנתי', 'בונוס רבעוני', 'מענק', 'הפרשי בונוס', 'Annual bonus', 'One-time bonus', 'Signing bonus']) expect(bonusRecurrence(label)).toBe('one_time');
    for (const label of ['בונוס', 'פרמיה', 'Bonus']) expect(bonusRecurrence(label)).toBe('unclear');
    expect(bonusRecurrence('בונוס', 'one_time')).toBe('one_time');expect(bonusRecurrence('בונוס', 'recurring')).toBe('unclear');
  });
  it('dates, codes and cut-off values are never amounts', () => {
    expect(tokens('07/2026')).toEqual([]);expect(tokens('01/01/2024')).toEqual([]);expect(tokens('00')).toEqual([]);expect(tokens('05')).toEqual([]);
    expect(tokens('0.00')[0].value).toBe(0);expect(tokens('12,000.00')[0].value).toBe(12000);
    // A value truncated at the page edge ("00") is never taken as the row's amount.
    expect(parsed(['שכר בסיס', '1.00', '12,000.00', '00']).base_salary.value).toBe(12000);
  });
  it('English and mixed labels are recognized', () => {
    const fields = parsed(['Base salary', '9,800.00'], ['Commissions', '400.00'], ['Employee car contribution', '250.00'], ['Tax credit points', '2.25']);
    expect([fields.base_salary.value, fields.commissions.value, fields.current_participation.value, fields.tax_credit_points.value]).toEqual([9800, 400, 250, 2.25]);
    expect(parsed(['Overtime 125%', '1,750.00'], ['Gross total', '20,000.00']).base_salary.value).toBeNull();
  });
  it('titles and page numbers are never field rows', () => {
    expect(parsed(['דוח שכר חודשי — 08/2026 — עמוד 2 מתוך 2'], ['שכר יסוד', '20,000.00']).base_salary.value).toBe(20000);
  });
  it('label-above-value pairing only pairs a label line with a numbers-only line of the same width', () => {
    expect(parsed(['שכר בסיס', 'עמלות'], ['9,000.00', '500.00']).commissions).toMatchObject({ value: 500, confidence: 'review' });
    // Different counts, or a data row with its own label, are never paired.
    expect(parsed(['שכר בסיס', 'עמלות'], ['9,000.00']).base_salary.value).toBeNull();
    expect(parsed(['תיאור', 'סכום'], ['שכר בסיס', '9,000.00']).base_salary).toMatchObject({ value: 9000, confidence: 'high' });
    // Far apart horizontally (another column of the page) is not a pair.
    expect(parsed({ page: 1, cells: [{ text: 'שכר בסיס', x: 500 }] }, { page: 1, cells: [{ text: '9,000.00', x: 100 }] }).base_salary.value).toBeNull();
  });
  it('a severance row is never the employee pension rate', () => {
    expect(parsed(['קרן פנסיה – תגמולי עובד', '6.00%'], ['קרן פנסיה – פיצויים', '8.33%']).employee_pension_percent.value).toBe(6);
  });
  it('a section the field is never printed in refuses the row (visual reading)', () => {
    const fields = byField(fieldsFromVision({ is_payslip: true, legibility: 'good', candidates: [
      row('base_salary', 'שכר בסיס', '9,000.00', { section: 'totals' }), row('tax_credit_points', 'נקודות זיכוי', '2.25', { section: 'balances' })] }));
    expect(fields.base_salary.value).toBeNull();expect(fields.tax_credit_points.value).toBeNull();
  });
});
