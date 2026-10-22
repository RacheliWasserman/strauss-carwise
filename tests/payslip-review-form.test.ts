import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { extractPayslip } from '../src/lib/payslip/payslip-service';
import { parsePayslipLines } from '../src/lib/payslip/payslip-parser';
import { fieldsFromVision, type VisionResponse } from '../src/lib/payslip/payslip-vision';
import { applyPayslipReview } from '../src/lib/payslip/payslip-handoff';
import { decodePayslipReview, encodePayslipReview, extractionResponseSchema, PAYSLIP_FIELD_ORDER, PAYSLIP_FIELDS, type PayslipField } from '../src/lib/payslip/payslip-contract';
import { buildPayslipReview, initialReviewRows, reviewRowState, type ExtractedResult } from '../src/lib/payslip/payslip-review-form';
import { PayslipReviewRow } from '../src/components/chat/payslip-review-row';
import type { AdvisorState } from '../src/lib/ai/advisor-state';
import type { DocumentLine } from '../src/lib/payslip/payslip-file';

/**
 * LIVE REGRESSION (2026-10-21): a visually read payslip showed base salary "זוהה בתלוש" and tax credit points
 * "לבדיקה" with their evidence, while the review row read as "לא ידוע". These tests pin every step from Gemini's
 * transcription to the editable field and the reviewed message. All values are synthetic; no document is used.
 */
process.env.SUPABASE_SECRET_KEY ||= 'test-only-secret';
const USER = '0b6c1d0e-4a59-4a3c-9f0f-6a1f2d9e7a11';
const CONVERSATION = '6f1d2c3b-8e7a-4b5c-9d0e-1f2a3b4c5d6e';
const MESSAGE = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
const image = () => new Uint8Array(readFileSync('tests/fixtures/payslips/payslip-a-screenshot.png'));

/** What Gemini transcribed: base salary and abbreviated credit points found, everything else not printed. */
const transcription: VisionResponse = { is_payslip: true, legibility: 'good', candidates: [
  { field: 'base_salary', label_text: 'שכר יסוד', value_text: '6,000.00', unit: 'currency', column: 'not_applicable', page: 1 },
  { field: 'tax_credit_points', label_text: 'נ״ז', value_text: '2.75', unit: 'number', page: 1 },
  
  ] };
const ABSENT: PayslipField[] = ['commissions', 'bonus', 'employee_pension_percent', 'employee_study_fund_percent', 'current_participation'];

/** The server's answer as the browser receives it: JSON over the wire, then the client's own schema. */
async function reviewResult(response: VisionResponse = transcription): Promise<ExtractedResult> {
  const result = await extractPayslip({ bytes: image(), userId: USER, conversationId: CONVERSATION, consent: true },
    { vision: async () => JSON.stringify(response), visionEnabled: () => true });
  const parsed = extractionResponseSchema.parse(JSON.parse(JSON.stringify(result)));
  if (parsed.status !== 'extracted') throw new Error('Expected an extraction');
  return parsed;
}
const renderRow = (result: ExtractedResult, field: PayslipField, rows = initialReviewRows(result)) => {
  vi.stubGlobal('React', React);
  return renderToStaticMarkup(React.createElement(PayslipReviewRow, { field, result, row: rows[field], onChange: () => {} }));
};
const inputValue = (html: string) => html.match(/<input id="cw-payslip-[a-z_]+"[^>]*\bvalue="([^"]*)"/)?.[1];
const lines = (...rows: string[][]): DocumentLine[] => rows.map(cells => ({ page: 1, cells: cells.map(text => ({ text })) })) as DocumentLine[];
const parsed = (...rows: string[][]) => Object.fromEntries(parsePayslipLines(lines(...rows)).fields.map(item => [item.field, item]));
const vision = (fields: VisionResponse['candidates']) => Object.fromEntries(fieldsFromVision({ is_payslip: true, legibility: 'good', candidates: fields }).map(item => [item.field, item]));

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('OCR → editable review form', () => {
  it('a clearly read base salary of 6,000 fills its field as 6000, marked as found in the payslip', async () => {
    const result = await reviewResult();
    const rows = initialReviewRows(result);
    expect(rows.base_salary).toEqual({ input: '6000', unknown: false });
    expect(reviewRowState(result, 'base_salary', rows.base_salary)).toBe('found');
    const html = renderRow(result, 'base_salary');
    expect(inputValue(html)).toBe('6000');
    expect(html).not.toMatch(/<input id="cw-payslip-base_salary"[^>]*disabled/);
    expect(html).toContain('זוהה בתלוש');expect(html).toContain('6,000.00');
    // The read value is also printed as text, so the row never reads as "לא ידוע".
    expect(html).toMatch(/הערך שנקרא: <bdi dir="ltr">6,000 ₪<\/bdi>/);
  });

  it('tax credit points 2.75 under the abbreviation נ״ז fill their field and stay for review', async () => {
    const result = await reviewResult();
    const rows = initialReviewRows(result);
    expect(rows.tax_credit_points).toEqual({ input: '2.75', unknown: false });
    expect(reviewRowState(result, 'tax_credit_points', rows.tax_credit_points)).toBe('review');
    const html = renderRow(result, 'tax_credit_points');
    expect(inputValue(html)).toBe('2.75');
    expect(html).toContain('דורש בדיקה');expect(html).toContain('נ&quot;ז · 2.75');
  });

  it('fields not printed stay empty and "not found": never 0, never a value', async () => {
    const result = await reviewResult();
    const rows = initialReviewRows(result);
    for (const field of ABSENT) {
      expect(rows[field]).toEqual({ input: '', unknown: false });
      expect(reviewRowState(result, field, rows[field])).toBe('missing');
      const html = renderRow(result, field);
      expect(inputValue(html)).toBe('');expect(html).toContain('לא נמצא בתלוש');expect(html).not.toContain('הערך שנקרא');
    }
  });

  it('the "unknown" checkbox is named for its own field, not read as a field value', async () => {
    const result = await reviewResult();
    for (const field of PAYSLIP_FIELD_ORDER) expect(renderRow(result, field)).toContain(`aria-label="לא ידוע: ${PAYSLIP_FIELDS[field].label}"`);
    const rows = initialReviewRows(result);
    const html = renderRow(result, 'base_salary', { ...rows, base_salary: { ...rows.base_salary, unknown: true } });
    expect(html).toMatch(/<input id="cw-payslip-base_salary"[^>]*disabled/);expect(html).toContain('cw-payslip-row-unknown');
  });

  it('the reviewed message carries the read numbers, leaves absent fields out, and reaches the summary as "from the payslip"', async () => {
    const result = await reviewResult();
    const review = buildPayslipReview(result, initialReviewRows(result))!;
    expect(review.values).toEqual({ base_salary: 6000, tax_credit_points: 2.75 });
    expect(review.extracted).toMatchObject({ base_salary: 6000, tax_credit_points: 2.75, commissions: null, employee_pension_percent: null });
    const decoded = decodePayslipReview(encodePayslipReview(review))!;
    const state = { userId: USER, conversationId: CONVERSATION, pendingFacts: [], unknownFacts: [] } as unknown as AdvisorState;
    const applied = applyPayslipReview(state, decoded, MESSAGE);
    expect(applied).toMatchObject({ provenance: 'valid', accepted: 2, unknownNow: [] });
    expect(state.pendingFacts).toEqual([
      { field: 'base_salary', value: 6000, sourceMessageId: MESSAGE, status: 'pending_confirmation', source: 'payslip' },
      { field: 'tax_credit_points', value: 2.75, sourceMessageId: MESSAGE, status: 'pending_confirmation', source: 'payslip' }]);
  });

  it('an employee correction is a correction, and an emptied field is not sent', async () => {
    const result = await reviewResult();
    const rows = initialReviewRows(result);
    const review = buildPayslipReview(result, { ...rows, base_salary: { input: '6,100', unknown: false }, tax_credit_points: { input: '', unknown: false } })!;
    expect(review.values).toEqual({ base_salary: 6100 });
    const state = { userId: USER, conversationId: CONVERSATION, pendingFacts: [], unknownFacts: [] } as unknown as AdvisorState;
    applyPayslipReview(state, review, MESSAGE);
    expect(state.pendingFacts).toEqual([{ field: 'base_salary', value: 6100, sourceMessageId: MESSAGE, status: 'pending_confirmation', source: 'corrected' }]);
  });
});

describe('Hebrew labels for tax credit points', () => {
  it.each(['נ״ז', 'נ"ז', 'נ.ז'])('visual reading recognizes the abbreviation %s, for review', label => {
    const field = vision([{ field: 'tax_credit_points', label_text: label, value_text: '2.75', unit: 'number' }]).tax_credit_points;
    expect(field).toMatchObject({ value: 2.75, confidence: 'review' });
    expect(field.warnings.join()).toContain('בקיצור');expect(field.warnings.join()).not.toContain('לא תואמת');
  });
  it.each(['נקודות זיכוי', 'נק׳ זיכוי', "נק' זיכוי"])('visual reading takes the full label %s as is', label => {
    expect(vision([{ field: 'tax_credit_points', label_text: label, value_text: '2.75', unit: 'number' }]).tax_credit_points)
      .toMatchObject({ value: 2.75, confidence: 'high', warnings: [] });
  });
  it('the text reader recognizes נ״ז and נק׳ זיכוי', () => {
    expect(parsed(['נ״ז', '2.75']).tax_credit_points).toMatchObject({ value: 2.75, confidence: 'review' });
    expect(parsed(['נק׳ זיכוי', '2.75']).tax_credit_points).toMatchObject({ value: 2.75, confidence: 'high' });
    // Words that merely contain the letters are not the abbreviation.
    expect(parsed(['נזק', '2.75']).tax_credit_points.value).toBeNull();
  });
});

describe('numbers that must not be taken for the field', () => {
  it('credit points are never chosen between 2.75 and 2.92, nor taken from shekels', () => {
    expect(vision([{ field: 'tax_credit_points', label_text: 'נ"ז', value_text: '2.75 2.92', unit: 'number' }]).tax_credit_points.value).toBeNull();
    expect(vision([{ field: 'tax_credit_points', label_text: 'נקודות זיכוי', value_text: '640.00', unit: 'currency' }]).tax_credit_points.value).toBeNull();
    const both = parsed(['נ"ז', '2.75', '2.92']).tax_credit_points;
    expect(both.value).toBeNull();expect(both.warnings.join()).toContain('2.92');
    // A 2.92 on another, unrelated row does not disturb the credit points row.
    expect(parsed(['נקודות זיכוי', '2.75'], ['שעות נוספות', '2.92']).tax_credit_points.value).toBe(2.75);
  });

  it('base salary 6,000 stays apart from taxable gross 6,267 that includes a 267 gross-up', () => {
    const text = parsed(['שכר יסוד', '6,000.00'], ['גילום', '267.00'], ['שכר יסוד + גילום', '6,267.00'], ['ברוטו למס', '6,267.00']);
    expect(text.base_salary).toMatchObject({ value: 6000, confidence: 'high' });
    const read = vision([
      { field: 'base_salary', label_text: 'ברוטו למס', value_text: '6,267.00', unit: 'currency' }]);
    expect(read.base_salary.value).toBeNull();
    expect(vision([{ field: 'base_salary', label_text: 'שכר יסוד כולל גילום', value_text: '6,267.00', unit: 'currency' }]).base_salary.value).toBeNull();
    expect(vision([{ field: 'base_salary', label_text: 'שכר יסוד', value_text: '6,000.00', unit: 'currency' }]).base_salary.value).toBe(6000);
  });

  it('employee pension and study-fund rates are never filled from defaults, amounts or a bare zero', () => {
    const read = vision([
      
      { field: 'employee_study_fund_percent', label_text: 'קרן השתלמות ניכוי עובד', value_text: '150.00', unit: 'currency', column: 'employee' },
      { field: 'commissions', value_text: '0' }]);
    expect(read.employee_pension_percent.value).toBeNull();expect(read.employee_study_fund_percent.value).toBeNull();
    expect(read.commissions.value).toBeNull();
    // A zero printed beside the field's own label is what the payslip says.
    expect(vision([{ field: 'commissions', label_text: 'עמלות', value_text: '0.00', unit: 'currency' }]).commissions.value).toBe(0);
    const text = parsed(['שכר יסוד', '6,000.00'], ['פנסיה עובד', '360.00'], ['קרן השתלמות עובד', '150.00']);
    expect(text.employee_pension_percent.value).toBeNull();expect(text.employee_study_fund_percent.value).toBeNull();
  });
});
