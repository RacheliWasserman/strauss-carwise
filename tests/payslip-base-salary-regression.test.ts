import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { parsePayslipLines } from '../src/lib/payslip/payslip-parser';
import { fieldsFromVision, type VisionResponse } from '../src/lib/payslip/payslip-vision';
import { extractPayslip } from '../src/lib/payslip/payslip-service';
import { initialReviewRows, reviewRowState, type ExtractedResult } from '../src/lib/payslip/payslip-review-form';
import { PayslipReviewRow } from '../src/components/chat/payslip-review-row';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const parse = (label: string) => parsePayslipLines([{ page: 1, cells: [{ text: label }, { text: '18,500.00' }] }]).fields;
const visual = (label: string) => fieldsFromVision({ is_payslip: true, legibility: 'good', candidates: [
  { field: 'base_salary', label_text: label, value_text: '18,500.00', section: 'earnings', period: 'current_month', unit: 'currency' }
] });

it.each(['שכר בסיס ברוטו', 'שכר יסוד (ברוטו)', 'משכורת בסיס ברוטו', 'Gross base salary', 'Base salary (gross)', 'Basic pay gross'])
('recognizes an explicitly labelled base salary, including its gross qualifier: %s', label => {
  for (const fields of [parse(label), visual(label)]) {
    expect(fields.find(item => item.field === 'base_salary')).toMatchObject({ value: 18500, confidence: 'high' });
  }
});

it.each(['שכר ברוטו', 'Gross salary', 'סה״כ שכר בסיס ברוטו', 'Total gross base salary', 'שכר בסיס ברוטו מצטבר',
  'שכר בסיס כולל גילום', 'Base salary gross-up', 'שכר בסיס לשעה', 'שכר בסיס נטו'])
('never substitutes a total, gross-only, cumulative, hourly or grossed-up amount: %s', label => {
  for (const fields of [parse(label), visual(label)]) expect(fields.find(item => item.field === 'base_salary')?.value).toBeNull();
});

// Newly authored synthetic fixture, NOT the original Noa upload (which is not in this repository).
it('synthetic Noa PDF → local PDF reader → validation → review: 18500 base and explicitly printed zero payments', async () => {
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-only-signing-secret');
  const vision = vi.fn();
  const result = await extractPayslip({ bytes: new Uint8Array(readFileSync('tests/fixtures/payslips/noa-synthetic.pdf')),
    userId: '0b6c1d0e-4a59-4a3c-9f0f-6a1f2d9e7a11', conversationId: '6f1d2c3b-8e7a-4b5c-9d0e-1f2a3b4c5d6e', consent: false },
  { vision, visionEnabled: () => true });
  expect(result.status).toBe('extracted');
  if (result.status !== 'extracted') throw new Error('Expected extracted fields');
  expect(result.method).toBe('pdf_text');
  expect(vision).not.toHaveBeenCalled();
  const rows = initialReviewRows(result);
  for (const [field, value] of [['base_salary', 18500], ['commissions', 0], ['bonus', 0]] as const) {
    expect(result.fields.find(item => item.field === field)).toMatchObject({ value, confidence: 'high' });
    expect(rows[field].input).toBe(String(value));
    expect(reviewRowState(result, field, rows[field])).toBe('found');
  }
  expect(result.fields.find(item => item.field === 'current_participation')?.value).toBeNull();
  expect(JSON.stringify(result)).not.toContain('נועה');
});

it('mocked visual transcription preserves explicit zero, but never fills absent fields', () => {
  const candidates: VisionResponse['candidates'] = [
    { field: 'base_salary', label_text: 'Gross base salary', value_text: '18,500.00', section: 'earnings', period: 'current_month' },
    { field: 'commissions', label_text: 'Commission', value_text: '0.00', section: 'earnings', period: 'current_month' },
    { field: 'bonus', label_text: 'Monthly bonus', value_text: '0.00', section: 'earnings', period: 'current_month' }
  ];
  const fields = fieldsFromVision({ is_payslip: true, legibility: 'good', candidates });
  expect(fields.slice(0, 3).map(item => [item.value, item.confidence])).toEqual([[18500, 'high'], [0, 'high'], [0, 'high']]);
  expect(fields.find(item => item.field === 'employee_pension_percent')?.value).toBeNull();
});

it('review translates technical source identifiers into Hebrew without changing the extracted values', () => {
  vi.stubGlobal('React', React);
  const result: ExtractedResult = { status: 'extracted', method: 'vision', warnings: [], token: 'a'.repeat(64), expiresAt: '2026-10-23T00:00:00.000Z',
    fields: [{ field: 'base_salary', value: 18500, confidence: 'review', evidence: 'base_salary · 18,500.00', page: 1, warnings: ['יש לבדוק מול התלוש.'] }] };
  const html = renderToStaticMarkup(React.createElement(PayslipReviewRow, { field: 'base_salary', result,
    row: initialReviewRows(result).base_salary, onChange: () => {} }));
  expect(html).toContain('מקור: עמוד 1');
  expect(html).toContain('שכר בסיס חודשי ברוטו · 18,500.00');
  expect(html).not.toMatch(/<bdi>base_salary/);
  expect(html).toContain('דורש בדיקה');
});
