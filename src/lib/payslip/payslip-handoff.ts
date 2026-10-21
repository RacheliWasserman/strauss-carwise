import 'server-only';
import { applyReviewedValue, markFieldUnknown, type FinancialNote } from '../ai/financial-flow';
import type { AdvisorState, FactField } from '../ai/advisor-state';
import { PAYSLIP_FIELD_ORDER, type PayslipReview } from './payslip-contract';
import { verifyExtraction } from './payslip-provenance';

export type AppliedPayslip = { accepted: number; unknownNow: FactField[]; notes: FinancialNote[]; text: string;
  provenance: 'valid' | 'expired' | 'invalid' | 'manual' };

/**
 * The employee's reviewed payslip values enter the conversation as pending values, exactly like typed answers.
 * A value is labelled "מתלוש" only when the server's signature proves it is unchanged from what the server read;
 * an edited value is labelled as the employee's correction. Nothing is saved or calculated until the existing
 * summary is approved with its code.
 */
export function applyPayslipReview(state: AdvisorState, review: PayslipReview, messageId: string, now = Date.now()): AppliedPayslip {
  const provenance = review.method === 'manual' ? 'manual' as const
    : verifyExtraction(state.userId, state.conversationId, review.method, review.extracted, review.expiresAt!, review.token!, now);
  const result: AppliedPayslip = { accepted: 0, unknownNow: [], notes: [], text: '', provenance };
  for (const field of PAYSLIP_FIELD_ORDER) {
    const value = review.values[field];
    if (value === undefined) continue;
    if (value === 'unknown') { markFieldUnknown(state, field); result.unknownNow.push(field); continue; }
    const extracted = review.extracted[field];
    const source = provenance !== 'valid' ? undefined : extracted === value ? 'payslip' : extracted !== null ? 'corrected' : undefined;
    const problem = applyReviewedValue(state, field, value, messageId, source);
    if (problem) result.notes.push({ field, text: problem, explicit: true });
    else result.accepted++;
  }
  const parts: string[] = [];
  const count = result.accepted === 1 ? 'ערך אחד' : `${result.accepted} ערכים`;
  if (result.accepted) parts.push(`קיבלתי ${count} ${provenance === 'manual' ? 'מהטופס' : 'מתלוש השכר שנבדק'}. הם יישמרו בפרופיל רק אחרי אישור הסיכום.`);
  if (result.accepted && (provenance === 'expired' || provenance === 'invalid')) parts.push(provenance === 'expired'
    ? 'עבר זמן רב מאז קריאת התלוש, ולכן הערכים מסומנים כהזנה שלך ולא "מתלוש".'
    : 'לא הצלחתי לאמת שהערכים הגיעו מהתלוש, ולכן הם מסומנים כהזנה שלך.');
  result.text = parts.join(' ');
  return result;
}
