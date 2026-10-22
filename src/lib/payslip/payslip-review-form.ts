import { PAYSLIP_FIELD_ORDER, PAYSLIP_FIELDS, PAYSLIP_REVIEW_KIND, type ExtractedField, type ExtractionResponse, type PayslipField, type PayslipReview } from './payslip-contract';

/**
 * The review form's state, kept apart from the dialog so the path from a server extraction to the editable fields
 * (and back to the reviewed message) is one tested function each. A value the server read fills its field as a
 * plain number; a field the server did not read stays empty and is asked later in the chat, never set to 0.
 */
export type ExtractedResult = Extract<ExtractionResponse, { status: 'extracted' }>;
export type ReviewRow = { input: string; unknown: boolean };
export type ReviewRows = Record<PayslipField, ReviewRow>;
/** found: a clear value · review: a candidate to check · missing: not printed · ambiguous: conflicting evidence, no value. */
export type ReviewRowState = 'manual' | 'unknown' | 'missing' | 'ambiguous' | 'found' | 'review';

/** Display only: translate protocol identifiers in older extraction evidence, never reinterpret its value. */
export function displayPayslipEvidence(evidence: string): string {
  return evidence.replace(/\b(base_salary|commissions|bonus|employee_pension_percent|employee_study_fund_percent|tax_credit_points|current_participation)\b/g,
    identifier => PAYSLIP_FIELDS[identifier as PayslipField].label);
}

/** "15,000" / "6.5%" / "₪ 900" → a number; empty → null; anything else → NaN. */
export function parseReviewInput(text: string) {
  const clean = text.replace(/[,\s₪%]/g, '');
  if (!clean) return null;
  return /^\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}
export function reviewRowError(field: PayslipField, row: ReviewRow) {
  if (row.unknown) return null;
  const value = parseReviewInput(row.input);
  if (value === null) return null;
  if (Number.isNaN(value)) return 'יש להזין מספר.';
  if (value > PAYSLIP_FIELDS[field].max) return 'הערך גבוה מדי.';
  if (field === 'base_salary' && value < 1000) return 'יש להזין שכר חודשי מלא בשקלים.';
  return null;
}

export const extractedField = (result: ExtractedResult | null, field: PayslipField): ExtractedField | undefined =>
  result?.fields.find(item => item.field === field);
const readValue = (result: ExtractedResult | null, field: PayslipField) => extractedField(result, field)?.value ?? null;

/** The editable rows for a new review: every read value as its number, everything else empty. */
export function initialReviewRows(result: ExtractedResult | null): ReviewRows {
  return Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => {
    const value = readValue(result, field);
    return [field, { input: value === null ? '' : String(value), unknown: false }];
  })) as ReviewRows;
}

/** A row's status follows what the server read; the employee's "unknown" overrides it. */
export function reviewRowState(result: ExtractedResult | null, field: PayslipField, row: ReviewRow): ReviewRowState {
  if (!result) return 'manual';
  if (row.unknown) return 'unknown';
  const found = extractedField(result, field);
  if (!found || found.value === null) return found?.ambiguous ? 'ambiguous' : 'missing';
  return found.confidence === 'high' ? 'found' : 'review';
}
export const reviewRowEdited = (result: ExtractedResult | null, field: PayslipField, row: ReviewRow) => {
  const value = parseReviewInput(row.input);
  return Boolean(result) && !row.unknown && value !== null && !Number.isNaN(value) && value !== readValue(result, field);
};

/**
 * The reviewed message: what the employee decided per field (a number, 'unknown', or left out when empty), beside
 * the server's signed extraction so the advisor can tell unchanged values from corrections. Null when nothing was given.
 */
export function buildPayslipReview(result: ExtractedResult | null, rows: ReviewRows): PayslipReview | null {
  const values: PayslipReview['values'] = {};
  for (const field of PAYSLIP_FIELD_ORDER) {
    const row = rows[field];
    const value = parseReviewInput(row.input);
    if (row.unknown) values[field] = 'unknown';
    else if (value !== null && !Number.isNaN(value)) values[field] = value;
  }
  if (!Object.keys(values).length) return null;
  const extracted = Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, readValue(result, field)])) as PayslipReview['extracted'];
  return result
    ? { kind: PAYSLIP_REVIEW_KIND, method: result.method, extracted, values, token: result.token, expiresAt: result.expiresAt }
    : { kind: PAYSLIP_REVIEW_KIND, method: 'manual', extracted, values };
}
