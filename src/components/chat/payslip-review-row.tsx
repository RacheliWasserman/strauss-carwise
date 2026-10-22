import { formatPayslipValue, PAYSLIP_FIELDS, type PayslipField } from '../../lib/payslip/payslip-contract';
import { extractedField, reviewRowEdited, reviewRowError, reviewRowState, type ExtractedResult, type ReviewRow } from '../../lib/payslip/payslip-review-form';

const BADGE = { manual: '', unknown: 'לא ידוע', missing: 'לא נמצא בתלוש', ambiguous: 'לא ניתן לקבוע בוודאות', found: 'זוהה בתלוש', review: 'דורש בדיקה' } as const;

/**
 * One reviewed field. The number the server read is the input's value and is also printed as text, so the row's
 * text never reads as "לא ידוע" for a value that was found: that word belongs only to the field's own checkbox.
 */
export function PayslipReviewRow({ field, result, row, onChange }: {
  field: PayslipField; result: ExtractedResult | null; row: ReviewRow; onChange: (patch: Partial<ReviewRow>) => void;
}) {
  const spec = PAYSLIP_FIELDS[field];
  const found = extractedField(result, field);
  const read = found?.value ?? null;
  const error = reviewRowError(field, row);
  const state = reviewRowState(result, field, row);
  const badge = reviewRowEdited(result, field, row) ? (read === null ? 'הוזן על ידך' : 'תוקן על ידך') : BADGE[state];
  const id = `cw-payslip-${field}`;
  return <li className={`cw-payslip-row cw-payslip-row-${state}`}>
    <div className="cw-payslip-row-head">
      <label htmlFor={id}>{spec.label}</label>
      {badge && <span className="cw-payslip-badge">{badge}</span>}
    </div>
    <div className="cw-payslip-field">
      <input id={id} className="cw-placeholder-rtl" inputMode="decimal" dir="ltr" autoComplete="off" value={row.unknown ? '' : row.input} disabled={row.unknown}
        placeholder={row.unknown ? 'לא ידוע' : 'ריק'} aria-invalid={Boolean(error)} aria-describedby={`${id}-help`}
        onChange={event => onChange({ input: event.target.value })} />
      <span className="cw-payslip-unit">{spec.unit}</span>
      <label className="cw-payslip-unknown">
        <input type="checkbox" checked={row.unknown} aria-label={`לא ידוע: ${spec.label}`} onChange={event => onChange({ unknown: event.target.checked })} />
        <span>לא ידוע</span>
      </label>
    </div>
    <div id={`${id}-help`} className="cw-payslip-help">
      {read !== null && <p className="cw-payslip-read">הערך שנקרא: <bdi dir="ltr">{formatPayslipValue(field, read)}</bdi></p>}
      {found?.evidence && <p className="cw-payslip-source">מקור: {found.page ? `עמוד ${found.page} · ` : ''}<bdi>{found.evidence}</bdi></p>}
      {error && <p className="cw-payslip-row-error">{error}</p>}
      {found?.warnings.map(warning => <p key={warning} className="cw-payslip-warning">{warning}</p>)}
    </div>
  </li>;
}
