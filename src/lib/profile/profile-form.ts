import { z } from 'zod';
import { identityInputSchema } from '../identity/employee-identity';
import { parseReviewInput } from '../payslip/payslip-review-form';
import type { PayslipField, PayslipReview } from '../payslip/payslip-contract';

/**
 * "הפרופיל שלי": the employee's own profile, edited by hand or from a reviewed payslip. Both write the SAME record the
 * chat approves (a new confirmed version of advisor_employee_data_versions), so there is one profile, never two.
 * Shared by the browser (immediate feedback) and the server (enforcement). Every stored field is NOT NULL, so a field
 * left empty is an error, never a silent 0, and an untouched field keeps its saved value because the form starts from it.
 */
export const PROFILE_NUMBER_FIELDS = {
  base_salary: { label: 'שכר בסיס חודשי ברוטו', unit: '₪', min: 1000, max: 1_000_000, integer: false },
  commissions: { label: 'עמלות חודשיות', unit: '₪', min: 0, max: 1_000_000, integer: false },
  bonus: { label: 'בונוס חודשי קבוע', unit: '₪', min: 0, max: 1_000_000, integer: false },
  employee_pension_percent: { label: 'הפרשת עובד לפנסיה', unit: '%', min: 0, max: 30, integer: false },
  employee_study_fund_percent: { label: 'הפרשת עובד לקרן השתלמות', unit: '%', min: 0, max: 30, integer: false },
  tax_credit_points: { label: 'נקודות זיכוי', unit: 'נקודות', min: 0, max: 50, integer: false },
  eligible_children_count: { label: 'ילדים עד גיל 23', unit: 'ילדים', min: 0, max: 40, integer: true },
  current_participation: { label: 'השתתפות חודשית ברכב היום', unit: '₪', min: 0, max: 100_000, integer: false }
} as const;
export type ProfileNumberField = keyof typeof PROFILE_NUMBER_FIELDS;
export const PROFILE_NUMBER_ORDER = Object.keys(PROFILE_NUMBER_FIELDS) as ProfileNumberField[];

/** The form's own state: text as typed. current_vehicle_id: '' = not chosen yet, NO_VEHICLE = no company car. */
export const NO_VEHICLE = 'NONE';
export type ProfileFormValues = Record<ProfileNumberField, string> & {
  firstName: string; lastName: string; occupationKey: string; current_vehicle_id: string;
};
export type ProfileFormField = keyof ProfileFormValues;

const amount = (field: ProfileNumberField) => {
  const spec = PROFILE_NUMBER_FIELDS[field];
  const base = z.number().finite().min(spec.min).max(spec.max);
  return spec.integer ? base.int() : base;
};
const vehicleId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/** The save request. `name` is sent only when the account has no stored name (identity storage not available). */
export const profileSaveSchema = z.object({
  basedOnVersionId: z.string().uuid().nullable(),
  occupationKey: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.object({ firstName: identityInputSchema.shape.firstName, lastName: identityInputSchema.shape.lastName }).strict().optional(),
  base_salary: amount('base_salary'),
  commissions: amount('commissions'),
  bonus: amount('bonus'),
  employee_pension_percent: amount('employee_pension_percent'),
  employee_study_fund_percent: amount('employee_study_fund_percent'),
  tax_credit_points: amount('tax_credit_points'),
  eligible_children_count: amount('eligible_children_count'),
  current_vehicle_id: vehicleId.nullable(),
  current_participation: amount('current_participation')
}).strict().refine(value => value.current_vehicle_id !== null || value.current_participation === 0,
  'Without a company car the participation is 0');
export type ProfileSave = z.infer<typeof profileSaveSchema>;

/** What the browser knows about the latest approved version (the profile shown when the page opens). */
export type ProfileSnapshot = Record<ProfileNumberField, number> & {
  versionId: string; version: number; confirmedAt: string | null; displayName: string; occupationTitle: string;
  /** The official occupation the saved title belongs to; null when the title is no longer on the official list. */
  occupationKey: string | null; current_vehicle_id: string | null;
};

const text = (value: number) => String(value);
/** The form opens with the saved profile, so a field nobody touched is saved again unchanged. */
export function initialProfileForm(snapshot: ProfileSnapshot | null, name: { firstName: string; lastName: string }): ProfileFormValues {
  const numbers = Object.fromEntries(PROFILE_NUMBER_ORDER.map(field => [field, snapshot ? text(snapshot[field]) : ''])) as Record<ProfileNumberField, string>;
  return { ...numbers, firstName: name.firstName, lastName: name.lastName, occupationKey: snapshot?.occupationKey ?? '',
    current_vehicle_id: snapshot ? snapshot.current_vehicle_id ?? NO_VEHICLE : '' };
}

/** A stored display name without an account name: first word as the first name, the rest as the last name (editable). */
export function splitDisplayName(displayName: string | null | undefined) {
  const words = (displayName ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return { firstName: words[0] ?? '', lastName: words.slice(1).join(' ') };
}

export type ProfileErrors = Partial<Record<ProfileFormField, string>>;
export type ProfileValidation = { payload: ProfileSave; errors?: never } | { payload?: never; errors: ProfileErrors };

function numberError(field: ProfileNumberField, input: string): string | number {
  const spec = PROFILE_NUMBER_FIELDS[field];
  const value = parseReviewInput(input);
  if (value === null) return 'שדה חובה. אם אין, יש להזין 0.';
  if (Number.isNaN(value)) return 'יש להזין מספר.';
  if (spec.integer && !Number.isInteger(value)) return 'יש להזין מספר שלם.';
  if (field === 'base_salary' && value < spec.min) return 'יש להזין שכר חודשי מלא בשקלים.';
  if (value < spec.min) return 'הערך נמוך מדי.';
  if (value > spec.max) return 'הערך גבוה מדי.';
  return value;
}

/**
 * Turns the form into a save request, or explains every problem. Nothing is filled in: an empty required field is an
 * error, the role must come from the official list, and without a company car the participation is 0 by definition.
 */
export function validateProfileForm(form: ProfileFormValues, options: { needsName: boolean; basedOnVersionId: string | null;
  occupationKeys: ReadonlySet<string>; vehicleIds: ReadonlySet<string> }): ProfileValidation {
  const errors: ProfileErrors = {};
  const numbers: Partial<Record<ProfileNumberField, number>> = {};
  const noVehicle = form.current_vehicle_id === NO_VEHICLE;
  for (const field of PROFILE_NUMBER_ORDER) {
    if (field === 'current_participation' && noVehicle) { numbers[field] = 0; continue; }
    const result = numberError(field, form[field]);
    if (typeof result === 'string') errors[field] = result; else numbers[field] = result;
  }
  if (!form.occupationKey) errors.occupationKey = 'יש לבחור תפקיד מהרשימה.';
  else if (!options.occupationKeys.has(form.occupationKey)) errors.occupationKey = 'התפקיד אינו ברשימת התפקידים הרשמית. יש לבחור תפקיד מהרשימה.';
  if (!form.current_vehicle_id) errors.current_vehicle_id = 'יש לבחור את הרכב הצמוד שלך היום, או "אין לי רכב צמוד".';
  else if (!noVehicle && !options.vehicleIds.has(form.current_vehicle_id)) errors.current_vehicle_id = 'הרכב אינו בקטלוג הפעיל. יש לבחור רכב מהרשימה.';
  let name: ProfileSave['name'];
  if (options.needsName) {
    const first = identityInputSchema.shape.firstName.safeParse(form.firstName);
    const last = identityInputSchema.shape.lastName.safeParse(form.lastName);
    if (!first.success) errors.firstName = first.error.issues[0]?.message ?? 'שם פרטי אינו תקין.';
    if (!last.success) errors.lastName = last.error.issues[0]?.message ?? 'שם משפחה אינו תקין.';
    if (first.success && last.success) name = { firstName: first.data, lastName: last.data };
  }
  if (Object.keys(errors).length) return { errors };
  const parsed = profileSaveSchema.safeParse({ basedOnVersionId: options.basedOnVersionId, occupationKey: form.occupationKey,
    ...(name ? { name } : {}), ...numbers, current_vehicle_id: noVehicle ? null : form.current_vehicle_id });
  return parsed.success ? { payload: parsed.data } : { errors: { base_salary: 'הפרטים אינם תקינים.' } };
}

/** The fields whose text differs from the saved profile (for the "unsaved changes" state). */
export function changedProfileFields(form: ProfileFormValues, initial: ProfileFormValues): ProfileFormField[] {
  return (Object.keys(form) as ProfileFormField[]).filter(field => {
    if (field in PROFILE_NUMBER_FIELDS) {
      const now = parseReviewInput(form[field]), before = parseReviewInput(initial[field]);
      return now === null || before === null || Number.isNaN(now) || Number.isNaN(before) ? form[field].trim() !== initial[field].trim() : now !== before;
    }
    return form[field].trim() !== initial[field].trim();
  });
}

/**
 * A reviewed payslip fills the form; nothing is saved until the employee saves the profile. Only values the employee
 * kept or typed in the review are applied: "unknown" and empty review rows leave the form's field as it was.
 */
export function applyPayslipToForm(form: ProfileFormValues, review: PayslipReview): { form: ProfileFormValues; applied: PayslipField[] } {
  const next = { ...form };
  const applied: PayslipField[] = [];
  for (const [field, value] of Object.entries(review.values) as Array<[PayslipField, number | 'unknown' | undefined]>) {
    if (typeof value !== 'number') continue;
    next[field] = String(value);
    applied.push(field);
  }
  // A participation amount from the payslip means a company car today; the car itself is still chosen by the employee.
  if (applied.includes('current_participation') && next.current_vehicle_id === NO_VEHICLE && Number(next.current_participation) > 0) next.current_vehicle_id = '';
  return { form: next, applied };
}
