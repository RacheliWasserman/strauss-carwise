import { z } from 'zod';

/**
 * Payslip extraction contract, shared by the upload route, the review screen and the advisor.
 * Extracted values are suggestions only: the employee reviews them, and they become profile values only through
 * the existing approval summary. The original document is never stored or put in the conversation.
 */
export const PAYSLIP_FIELDS = {
  base_salary: { label: 'שכר בסיס חודשי ברוטו', unit: '₪', kind: 'money', max: 1_000_000 },
  commissions: { label: 'עמלות חודשיות', unit: '₪', kind: 'money', max: 1_000_000 },
  bonus: { label: 'בונוס חודשי קבוע', unit: '₪', kind: 'money', max: 1_000_000 },
  employee_pension_percent: { label: 'הפרשת עובד לפנסיה', unit: '%', kind: 'percent', max: 30 },
  employee_study_fund_percent: { label: 'הפרשת עובד לקרן השתלמות', unit: '%', kind: 'percent', max: 30 },
  tax_credit_points: { label: 'נקודות זיכוי', unit: 'נקודות', kind: 'points', max: 50 },
  current_participation: { label: 'השתתפות חודשית ברכב', unit: '₪', kind: 'money', max: 100_000 }
} as const;
export type PayslipField = keyof typeof PAYSLIP_FIELDS;
export const PAYSLIP_FIELD_ORDER = Object.keys(PAYSLIP_FIELDS) as PayslipField[];
export const payslipFieldSchema = z.enum(PAYSLIP_FIELD_ORDER as [PayslipField, ...PayslipField[]]);

/** Limits shared by the browser (early feedback) and the server (enforcement). */
export const PAYSLIP_LIMITS = { maxBytes: 4 * 1024 * 1024, maxPdfPages: 5, maxImagePixels: 40_000_000 } as const;
export const PAYSLIP_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.docx,application/pdf,image/jpeg,image/png,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The exact consent the employee gives, per upload, before a document is sent to Google Gemini. */
// v2: the wording now states automatic retries on temporary overload. A v1 consent is no longer accepted.
export const VISION_CONSENT_VERSION = 'carwise.payslip-vision-consent.v2';
export const VISION_CONSENT_TEXT = 'אישור לשליחת הקובץ הזה לשירות Google Gemini בלבד, לצורך קריאת נתוני השכר שבו. ' +
  'אם השירות עמוס, אותו קובץ יישלח שוב לאותו שירות עד פעמיים באופן אוטומטי. הקובץ לא יישמר במערכת, ורק השדות הדרושים לחישוב יוחזרו לבדיקה.';

export const extractedFieldSchema = z.object({
  field: payslipFieldSchema,
  value: z.number().finite().nonnegative().nullable(),
  /** Masked label and printed value only; never a whole document line. */
  evidence: z.string().max(120).optional(),
  page: z.number().int().positive().max(PAYSLIP_LIMITS.maxPdfPages).optional(),
  confidence: z.enum(['high', 'review']),
  warnings: z.array(z.string().max(200)).max(4),
  /** No value because the document holds conflicting values for this field (as opposed to not printing it). */
  ambiguous: z.literal(true).optional()
}).strict();
export type ExtractedField = z.infer<typeof extractedFieldSchema>;
export const extractionMethodSchema = z.enum(['pdf_text', 'docx', 'vision']);
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;

export const extractionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('extracted'), method: extractionMethodSchema, fields: z.array(extractedFieldSchema).length(PAYSLIP_FIELD_ORDER.length),
    warnings: z.array(z.string().max(200)).max(6), token: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal('needs_vision'), reason: z.enum(['image', 'scanned_pdf', 'no_fields']), visionAvailable: z.boolean() }).strict()
]);
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

/**
 * The reviewed values the employee sends into the chat. `extracted` + `token` let the server verify which values
 * came unchanged from the document; `values` are what the employee decided (a number, 'unknown', or left out).
 */
export const PAYSLIP_REVIEW_KIND = 'carwise.payslip-review.v1';
const valuesShape = Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, z.union([z.number().finite().nonnegative(), z.literal('unknown')]).optional()])) as
  Record<PayslipField, z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodLiteral<'unknown'>]>>>;
const extractedShape = Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, z.number().finite().nonnegative().nullable()])) as
  Record<PayslipField, z.ZodNullable<z.ZodNumber>>;
export const payslipReviewSchema = z.object({
  // 'manual': the employee filled the same form without an extraction (e.g. visual reading unavailable).
  kind: z.literal(PAYSLIP_REVIEW_KIND), method: z.union([extractionMethodSchema, z.literal('manual')]),
  extracted: z.object(extractedShape).strict(), values: z.object(valuesShape).strict(),
  token: z.string().regex(/^[a-f0-9]{64}$/).optional(), expiresAt: z.string().datetime().optional()
}).strict().refine(review => review.method === 'manual'
  ? !review.token && !review.expiresAt && Object.values(review.extracted).every(value => value === null)
  : Boolean(review.token && review.expiresAt), 'Extraction reviews carry their signature; manual entries carry none')
  .refine(review => Object.values(review.values).some(value => value !== undefined), 'At least one reviewed value');
export type PayslipReview = z.infer<typeof payslipReviewSchema>;
export function encodePayslipReview(review: PayslipReview) { return JSON.stringify(payslipReviewSchema.parse(review)); }
export function decodePayslipReview(body: string): PayslipReview | null {
  if (!body.startsWith('{') || body.length > 3000 || !body.includes(PAYSLIP_REVIEW_KIND)) return null;
  try { const parsed = payslipReviewSchema.safeParse(JSON.parse(body)); return parsed.success ? parsed.data : null; } catch { return null; }
}

export function formatPayslipValue(field: PayslipField, value: number) {
  const unit = PAYSLIP_FIELDS[field].unit;
  return unit === '₪' ? `${value.toLocaleString('he-IL')} ₪` : unit === '%' ? `${value.toLocaleString('he-IL')}%` : value.toLocaleString('he-IL');
}
/** One readable line per reviewed value, for the chat bubble and for model context (never the raw document). */
export function describePayslipReview(review: PayslipReview) {
  const parts = PAYSLIP_FIELD_ORDER.flatMap(field => {
    const value = review.values[field];
    if (value === undefined) return [];
    return [`${PAYSLIP_FIELDS[field].label}: ${value === 'unknown' ? 'לא ידוע' : formatPayslipValue(field, value)}`];
  });
  return `${review.method === 'manual' ? 'פרטי השכר שלי, כפי שהזנתי בטופס' : 'פרטים מתלוש השכר, אחרי בדיקה שלי'}: ${parts.join(' · ')}`;
}

/**
 * Masks identifiers in any text shown as evidence: long digit runs (ID, bank and employee numbers) and values
 * that follow identifier keywords. Formatted amounts ("15,000.00", "6.5%") are kept.
 */
export function maskIdentifiers(text: string) {
  return text
    .replace(/(ת\.?\s?ז\.?|ת["״]ז|תעודת זהות|מספר זהות|זהות|חשבון|בנק|סניף|IBAN|מס['׳]? עובד|מספר עובד)\s*[:.]?\s*[\w\-/]+/giu, '$1 •••')
    .replace(/(?<![\d,.])\d{6,}(?![\d]|[.,]\d)/g, '•••');
}
