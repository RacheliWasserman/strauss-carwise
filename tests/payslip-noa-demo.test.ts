import { existsSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { parsePayslipLines } from '../src/lib/payslip/payslip-parser';
import { extractPayslip } from '../src/lib/payslip/payslip-service';
import { buildPayslipReview, initialReviewRows, reviewRowState } from '../src/lib/payslip/payslip-review-form';
import { applyPayslipToForm, initialProfileForm } from '../src/lib/profile/profile-form';
import type { PayslipField } from '../src/lib/payslip/payslip-contract';

afterEach(() => { vi.unstubAllEnvs(); });

// The two demo payslips the user uploaded for Noa Levi (both marked fictional / demo only; no ID number is printed):
// noa-demo-he.pdf is a Hebrew RTL layout (gross, car benefit, car budget and net printed beside the fields);
// noa-demo-en.pdf prints English labels left to right with the value column on the right.
const EXPECTED: Record<PayslipField, number> = { base_salary: 18500, commissions: 0, bonus: 0, employee_pension_percent: 6,
  employee_study_fund_percent: 2.5, tax_credit_points: 2.75, current_participation: 300 };

// The PDFs are kept out of the repository (.gitignore): this test runs where they exist locally.
for (const file of ['noa-demo-he.pdf', 'noa-demo-en.pdf']) it.skipIf(!existsSync(`tests/fixtures/payslips/${file}`))(`${file} → local PDF text → validation → review → profile form, without Gemini`, async () => {
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-only-signing-secret');
  const vision = vi.fn();
  const result = await extractPayslip({ bytes: new Uint8Array(readFileSync(`tests/fixtures/payslips/${file}`)),
    userId: '0b6c1d0e-4a59-4a3c-9f0f-6a1f2d9e7a11', conversationId: 'profile', consent: false }, { vision, visionEnabled: () => true });
  expect(vision).not.toHaveBeenCalled();
  if (result.status !== 'extracted') throw new Error(`Expected extracted fields, got ${result.status}`);
  expect(result.method).toBe('pdf_text');
  const rows = initialReviewRows(result);
  for (const [field, value] of Object.entries(EXPECTED) as Array<[PayslipField, number]>) {
    expect(result.fields.find(item => item.field === field)?.value, field).toBe(value);
    expect(rows[field].input, field).toBe(String(value));
    expect(['found', 'review'], field).toContain(reviewRowState(result, field, rows[field]));
  }
  // Zero is a value, shown as found: never empty, never "for review" because of a recurrence question.
  for (const field of ['commissions', 'bonus'] as const) expect(reviewRowState(result, field, rows[field])).toBe('found');
  expect(JSON.stringify(result)).not.toContain('נועה');
  // The reviewed values only fill the profile form; saving is a separate, explicit action.
  const review = buildPayslipReview(result, rows)!;
  const { form, applied } = applyPayslipToForm(initialProfileForm(null, { firstName: 'נועה', lastName: 'לוי' }), review);
  expect(applied.sort()).toEqual(Object.keys(EXPECTED).sort());
  expect(form).toMatchObject({ base_salary: '18500', commissions: '0', bonus: '0', tax_credit_points: '2.75', current_participation: '300' });
});

const line = (...cells: string[]) => ({ page: 1, cells: cells.map(text => ({ text })) });
const value = (fields: ReturnType<typeof parsePayslipLines>['fields'], field: PayslipField) => fields.find(item => item.field === field)?.value;

it('reads labels glued to their amounts, and never takes gross, car benefit, car budget or net instead', () => {
  const { fields } = parsePayslipLines([
    line('תלוש שכר'),
    line('שכר יסוד חודשי18,500.00'), line('עמלות0.00'), line('בונוס0.00'), line('סך שכר ברוטו18,500.00'),
    line('פנסיית עובד6%'), line('קרן השתלמות עובד2.5%'), line('נקודות זיכוי2.75'),
    line('השתתפות העובדת ברכב300.00'), line('שווי שימוש ברכב4,070.00'), line('תקציב רכב4,500.00'), line('נטו לתשלום11,032.00')
  ]);
  for (const [field, expected] of Object.entries(EXPECTED) as Array<[PayslipField, number]>) expect(value(fields, field), field).toBe(expected);
});

it('a glued bare integer is still a code, not an amount', () => {
  const { fields } = parsePayslipLines([line('תלוש שכר'), line('שכר יסוד קוד1234')]);
  expect(value(fields, 'base_salary')).toBeNull();
});

it('without a base row, gross / net / car benefit are never the base salary or the participation', () => {
  const { fields } = parsePayslipLines([line('תלוש שכר'), line('סך שכר ברוטו', '18,500.00'), line('נטו חודשי', '11,032.00'),
    line('שווי שימוש ברכב', '4,070.00'), line('תקציב קבוצת הזכאות', '4,500.00')]);
  expect(value(fields, 'base_salary')).toBeNull();
  expect(value(fields, 'current_participation')).toBeNull();
});

it('a note between label and amount is skipped, but another label there still ends the row', () => {
  expect(value(parsePayslipLines([line('תלוש שכר'), line('השתתפות העובדת ברכב', 'ניכוי מהנטו', '300.00')]).fields, 'current_participation')).toBe(300);
  expect(value(parsePayslipLines([line('תלוש שכר'), line('שכר יסוד', 'מס הכנסה', '2,000.00')]).fields, 'base_salary')).toBeNull();
});
