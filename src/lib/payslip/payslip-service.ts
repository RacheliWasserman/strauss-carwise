import 'server-only';
import { checkFact } from '../ai/financial-flow';
import { PAYSLIP_FIELDS, PAYSLIP_LIMITS, type ExtractedField, type ExtractionMethod, type ExtractionResponse, type PayslipField } from './payslip-contract';
import { detectFileType, extractDocxLines, PayslipFileError } from './payslip-file';
import { normalizeImage } from './payslip-image';
import { parsePayslipLines } from './payslip-parser';
import { extractPdfText, looksScanned } from './payslip-pdf';
import { signExtraction } from './payslip-provenance';
import { fieldsFromVision, geminiVision, readWithVision, visionEnabled, VisionFailure, visionModel, type VisionCall, type VisionDiagnostic, type VisionDocument, type VisionOptions } from './payslip-vision';

export type PayslipErrorCode = 'empty' | 'too_large' | 'unsupported' | 'legacy_doc' | 'heic' | 'invalid_file' | 'encrypted' | 'macro'
  | 'too_many_pages' | 'image_too_large' | 'no_fields' | 'not_payslip' | 'timeout' | 'vision_disabled' | 'vision_unavailable' | 'vision_timeout' | 'vision_invalid'
  | 'vision_busy' | 'vision_rejected';
export class PayslipError extends Error {
  /** Sanitized provider facts for the server log (never document content, values or upstream text). */
  constructor(public code: PayslipErrorCode, public diagnostic?: VisionDiagnostic & { model?: string }) { super('Payslip extraction failed'); }
}

const LOCAL_TIMEOUT_MS = 15_000;
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PayslipError('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}
const fileError = (error: unknown): never => {
  if (error instanceof PayslipFileError) {
    const map: Record<PayslipFileError['code'], PayslipErrorCode> = { invalid_docx: 'invalid_file', docx_macro: 'macro', docx_encrypted: 'encrypted',
      too_large: 'too_large', invalid_pdf: 'invalid_file', pdf_encrypted: 'encrypted', too_many_pages: 'too_many_pages', invalid_image: 'invalid_file',
      image_too_large: 'image_too_large' };
    throw new PayslipError(map[error.code]);
  }
  throw error;
};

/**
 * The last gate for every suggested value, whatever produced it: the same range and unit checks as values the
 * employee types (checkFact). A value that fails is not suggested; the reason is shown instead.
 */
export function finalizeFields(fields: ExtractedField[]): ExtractedField[] {
  return fields.map(item => {
    if (item.value === null) return item;
    const unit = PAYSLIP_FIELDS[item.field].unit;
    const checked = checkFact(item.field, item.value, `${item.value}${unit === '%' ? '%' : unit === '₪' ? ' ₪' : ''}`);
    if (checked.ok) return item;
    return { field: item.field, value: null, confidence: 'review', warnings: [`הערך שנקרא (${item.value.toLocaleString('he-IL')}) לא עבר בדיקה: ${checked.note}`.slice(0, 200)] };
  });
}

export type ExtractInput = { bytes: Uint8Array; userId: string; conversationId: string; consent: boolean; ref?: string };
export type ExtractDependencies = { vision?: VisionCall; visionEnabled?: () => boolean; now?: () => number; visionOptions?: VisionOptions };
/** Safe model name for logs (configuration value, never a key). */
const safeModelName = (name: string) => /^[a-z0-9][a-z0-9.\-]{0,60}$/i.test(name) ? name : 'unrecognized';
const VISION_CODES: Record<VisionFailure['reason'], PayslipErrorCode> = { timeout: 'vision_timeout', invalid_output: 'vision_invalid', rate_limited: 'vision_busy',
  rejected: 'vision_rejected', not_configured: 'vision_disabled', blocked: 'vision_rejected', unavailable: 'vision_unavailable' };

/**
 * Format-aware extraction. Digital PDF and DOCX are read locally. Images, scanned PDFs, and PDFs whose text holds no
 * payslip fields need visual reading, which is offered (never performed) until the employee consents for this file.
 * The file exists only in memory for this request.
 */
export async function extractPayslip(input: ExtractInput, deps: ExtractDependencies = {}): Promise<ExtractionResponse> {
  const { bytes } = input;
  if (!bytes.length) throw new PayslipError('empty');
  if (bytes.length > PAYSLIP_LIMITS.maxBytes) throw new PayslipError('too_large');
  const type = detectFileType(bytes);
  if (type === 'doc_legacy') throw new PayslipError('legacy_doc');
  if (type === 'heic') throw new PayslipError('heic');
  if (type === 'unsupported') throw new PayslipError('unsupported');
  const enabled = (deps.visionEnabled ?? visionEnabled)();

  const done = (method: ExtractionMethod, fields: ExtractedField[], warnings: string[]): ExtractionResponse => {
    const checked = finalizeFields(fields);
    const extracted = Object.fromEntries(checked.map(item => [item.field, item.value])) as Record<PayslipField, number | null>;
    const { token, expiresAt } = signExtraction(input.userId, input.conversationId, method, extracted, deps.now?.());
    return { status: 'extracted', method, fields: checked, warnings: warnings.slice(0, 6), token, expiresAt };
  };

  let visual: { reason: 'image' | 'scanned_pdf' | 'no_fields'; document: () => Promise<{ document: VisionDocument; warnings: string[] }> };
  if (type === 'docx') {
    const lines = await withDeadline(Promise.resolve().then(() => extractDocxLines(bytes)), LOCAL_TIMEOUT_MS).catch(fileError);
    const parsed = parsePayslipLines(lines);
    if (!parsed.found) throw new PayslipError(parsed.looksLikePayslip ? 'no_fields' : 'not_payslip');
    return done('docx', parsed.fields, parsed.warnings);
  } else if (type === 'pdf') {
    const text = await withDeadline(extractPdfText(bytes), LOCAL_TIMEOUT_MS).catch(fileError);
    const scanned = looksScanned(text);
    if (!scanned) {
      const parsed = parsePayslipLines(text.lines);
      if (parsed.found) return done('pdf_text', parsed.fields, parsed.warnings);
    }
    visual = { reason: scanned ? 'scanned_pdf' : 'no_fields', document: async () => ({ document: { data: bytes, mimeType: 'application/pdf' }, warnings: [] }) };
  } else {
    visual = { reason: 'image', document: async () => {
      const image = await normalizeImage(bytes).catch(fileError);
      return { document: { data: image.data, mimeType: 'image/jpeg' }, warnings: image.warnings };
    } };
  }

  // Visual reading: never without consent for this upload, never when disabled, never with another provider.
  if (!input.consent) return { status: 'needs_vision', reason: visual.reason, visionAvailable: enabled };
  if (!enabled) throw new PayslipError('vision_disabled');
  const prepared = await visual.document();
  let response;
  try { response = await readWithVision(prepared.document, deps.vision ?? geminiVision, deps.visionOptions); }
  catch (error) {
    if (error instanceof VisionFailure) {
      // Google's own 503 "high demand" (after our retries) is a temporary overload, said as such to the employee.
      const busy = error.reason === 'unavailable' && [500, 502, 503].includes(error.diagnostic.httpStatus ?? 0);
      throw new PayslipError(busy ? 'vision_busy' : VISION_CODES[error.reason], { ...error.diagnostic, model: safeModelName(visionModel()) });
    }
    throw new PayslipError('vision_unavailable');
  }
  console.info('[carwise.payslip.vision]', { ref: input.ref ?? null, outcome: 'read', attempts: response.attempts, model: safeModelName(visionModel()) });
  const fields = fieldsFromVision(response);
  if (!fields.some(item => item.value !== null)) throw new PayslipError(response.is_payslip ? 'no_fields' : 'not_payslip');
  return done('vision', fields, ['הנתונים נקראו בקריאה חזותית ועשויים לכלול טעויות. כדאי לבדוק כל ערך מול התלוש.', ...prepared.warnings]);
}

/** Employee-facing explanations; never technical details, file contents or values. */
export const PAYSLIP_ERROR_TEXT: Record<PayslipErrorCode, { status: number; text: string }> = {
  empty: { status: 400, text: 'הקובץ ריק.' },
  too_large: { status: 413, text: 'הקובץ גדול מדי. אפשר להעלות קובץ עד 4MB.' },
  unsupported: { status: 415, text: 'סוג הקובץ לא נתמך. אפשר להעלות PDF, JPG, PNG, WEBP או DOCX.' },
  legacy_doc: { status: 415, text: 'קובצי Word ישנים (.doc) לא נתמכים. אפשר לשמור את הקובץ כ־DOCX או כ־PDF ולהעלות שוב.' },
  heic: { status: 415, text: 'תמונות HEIC (מאייפון) לא נתמכות. אפשר לצלם צילום מסך של התלוש, או לשמור את התמונה כ־JPG.' },
  invalid_file: { status: 422, text: 'לא הצלחתי לפתוח את הקובץ. ייתכן שהוא פגום או שאינו בפורמט שנכתב בשמו.' },
  encrypted: { status: 422, text: 'הקובץ מוגן בסיסמה. אפשר לשמור עותק בלי סיסמה ולהעלות אותו.' },
  macro: { status: 415, text: 'קבצי Word עם מאקרו לא נתמכים. אפשר לשמור את הקובץ כ־DOCX רגיל או כ־PDF.' },
  too_many_pages: { status: 422, text: 'הקובץ ארוך מדי. אפשר להעלות תלוש של עד 5 עמודים.' },
  image_too_large: { status: 413, text: 'התמונה גדולה מדי. אפשר להעלות צילום מסך או תמונה קטנה יותר.' },
  no_fields: { status: 422, text: 'לא זיהיתי בקובץ נתוני שכר שאפשר להעתיק. אפשר להזין את הפרטים ידנית.' },
  not_payslip: { status: 422, text: 'הקובץ לא נראה כמו תלוש שכר. אפשר להעלות תלוש אחר או להזין את הפרטים ידנית.' },
  timeout: { status: 504, text: 'עיבוד הקובץ ארך יותר מדי. אפשר לנסות קובץ אחר או להזין את הפרטים ידנית.' },
  vision_disabled: { status: 503, text: 'קריאה חזותית של תמונות ותלושים סרוקים לא זמינה כרגע. אפשר להעלות PDF דיגיטלי או DOCX, או להזין את הפרטים ידנית.' },
  vision_unavailable: { status: 503, text: 'שירות הקריאה החזותית לא זמין כרגע. אפשר לנסות שוב מאוחר יותר או להזין את הפרטים ידנית.' },
  vision_timeout: { status: 504, text: 'הקריאה החזותית ארכה יותר מדי. אפשר לנסות שוב או להזין את הפרטים ידנית.' },
  vision_invalid: { status: 502, text: 'לא הצלחתי לקרוא את התלוש בצורה אמינה. אפשר לנסות תמונה ברורה יותר או להזין את הפרטים ידנית.' },
  vision_busy: { status: 503, text: 'שירות הקריאה החזותית של Google עמוס כרגע (עומס זמני). אפשר לנסות שוב בעוד דקה, או להזין את הפרטים ידנית.' },
  vision_rejected: { status: 502, text: 'שירות הקריאה החזותית לא הצליח לעבד את הקובץ הזה. אפשר לנסות תמונה אחרת או להזין את הפרטים ידנית.' }
};
