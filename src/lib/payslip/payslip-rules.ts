import { maskIdentifiers, type PayslipField } from './payslip-contract';

/**
 * Shared, deterministic payslip rules for every reader: the local text reader (digital PDF / DOCX) and the server-side
 * validation of a visual transcription. Readers only collect candidate rows (label, printed value, page and whatever
 * structure they know); these rules decide which candidates may be a field, and `resolveField` decides the field:
 * one supported value, nothing, or explicitly ambiguous. There are no amounts, employers or templates here, only the
 * vocabulary of Israeli payslips and conservative rules.
 */

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩֑-ׇ]/g;
export const normalize = (text: string) => text.replace(BIDI_MARKS, '').replace(/[״“”„]/g, '"').replace(/[׳’‘`]/g, "'").replace(/\s+/g, ' ').trim();
/** Visual-order PDFs store each Hebrew phrase reversed ("דוסי רכש"); this restores logical order. */
export const reverseHebrewRuns = (text: string) =>
  text.replace(/[\p{Script=Hebrew}"'][\p{Script=Hebrew}"' ]*[\p{Script=Hebrew}"']|[\p{Script=Hebrew}]/gu, run => [...run].reverse().join(''));
/**
 * Other generators keep each word intact but store a cell's words in reverse order ("יסוד שכר", ")פטור( נסיעה");
 * this restores reading order, with the mirrored parentheses. Cells without Hebrew (amounts) are left as they are.
 */
export const reverseWordOrder = (text: string) => !/\p{Script=Hebrew}/u.test(text) || !text.includes(' ') ? text
  : text.split(' ').reverse().join(' ').replace(/[()]/g, bracket => bracket === '(' ? ')' : '(');

/** Hebrew word boundaries (\b only knows ASCII); English alternatives use \b. All patterns run on normalized text. */
const he = (pattern: string) => `(?:^|[^\\p{L}])(?:${pattern})(?=$|[^\\p{L}])`;
const re = (...parts: string[]) => new RegExp(parts.join('|'), 'iu');
export const PAYSLIP_PATTERNS = {
  base: re('(?:שכר|משכורת)\\s+(?:יסוד|בסיס|משולב(?:ת)?)', he('(?:שכר|משכורת)\\s+חודשי(?:ת)?'), '\\b(?:base|basic)\\s+(?:gross\\s+)?(?:salary|pay|wage)\\b'),
  /** A combined salary (שכר משולב) may include overtime or other components: recognized, but always for review. */
  combined: /משולב/u,
  /** Year-to-date and cumulative figures (rows or table columns), never the current month's value. */
  cumulative: re('מצטבר', 'מתחילת\\s+(?:ה)?שנה', '\\bYTD\\b', 'year[\\s-]*to[\\s-]*date', '\\bcumulative\\b'),
  /** Lines that mention the car but are not the employee's payment for it: totals, benefit, gross-up, imputation, fuel. */
  participationExclude: re('סך', 'סה"כ', 'כולל', 'שווי', 'גילום', 'זקיפ', 'דלק', '\\b(?:total|benefit|fuel|gross[\\s-]*up)\\b'),
  // A gross-up (גילום) is a separate payment: base plus gross-up is taxable gross, never the base salary.
  grossUp: re('גילום', '\\bgross[\\s-]*up\\b'),
  commissions: re(he('[והבל]?(?:עמלות|עמלה|עמלת)'), '\\bcommissions?\\b'),
  bonus: re(he('[והבל]?(?:בונוס|בונוסים|פרמיה|פרמיות|מענק|מענקים|תמריץ|תמריצים)'), '\\b(?:bonus|premium|incentive|grant)\\b'),
  /** Printed words that make a payment one-time (or not this month's regular pay). */
  oneTime: re('חד[- ]?פעמי', 'שנתי', 'רבעוני', 'חצי[- ]?שנתי', he('חג'), 'יובל', 'הוקרה', 'מיוחד', 'הפרשי', 'הפרשים', 'רטרו', 'חתימה',
    '\\b(?:one[\\s-]*(?:time|off)|annual|yearly|quarterly|holiday|special|retro\\w*|signing)\\b'),
  /** Printed words that make a payment recurring. */
  recurring: re('קבוע', 'קבועה', he('חודשי(?:ת)?'), 'שוטף', 'שוטפת', '\\b(?:monthly|fixed|recurring|regular)\\b'),
  /** A grant is one-time unless printed as recurring. */
  grant: re('מענק', '\\bgrant\\b'),
  pension: re('פנסי', 'תגמולים', 'קופ"?ג', 'קופת גמל', 'ביטוח מנהלים', he('גמל'), '\\b(?:pension|provident)\\b'),
  study: re('השתלמות', 'קה"ש', 'קרן השת', '\\bstudy[\\s-]*fund\\b', 'hishtalmut'),
  credit: re('נק(?:ודות|ודת|\'|\\.)?\\s*(?:ה)?זיכוי', '(?:^|[^\\p{L}])נ(?:"|\\.\\s?)ז(?![\\p{L}"])', '\\b(?:tax\\s+)?credit\\s+points?\\b'),
  /** The abbreviation נ"ז / נ.ז (normalize turns ״ into "): recognized, but always for review. */
  creditShort: /(?:^|[^\p{L}])נ(?:"|\.\s?)ז(?![\p{L}"])/u,
  participation: re('(?:השתתפות|השתת\'|ניכוי)[^|]{0,20}רכב', '\\b(?:car|vehicle)\\s+(?:employee\\s+)?(?:contribution|participation|deduction)\\b', '\\bemployee\\s+(?:car|vehicle)\\b'),
  carBenefit: re('שווי\\s*(?:שימוש\\s*)?(?:ב|ה)?רכב', 'שווי רכב', '\\b(?:car|vehicle)\\s+benefit\\b'),
  gross: re('סה"כ\\s*(?:תשלומים|ברוטו)', 'שכר ברוטו', '(?:^|[^\\p{L}])ברוטו\\s+(?:למס|לב"ל|חייב)', 'סה"כ\\s+שכר', 'חייב\\s+במס',
    '\\b(?:gross\\s+(?:pay|salary|total)|total\\s+(?:gross|earnings|payments))\\b'),
  identifier: /ת\.?ז|ת"ז|זהות|חשבון|בנק|סניף|IBAN|כתובת|מיקוד/iu,
  employee: re(he('[הלמ]?(?:עובד|עובדת|עובדים)|חלק\\s+העובד'), '\\bemployee\\b'),
  employer: re('מעביד', 'מעסיק', '\\bemployer\\b'),
  severance: re('פיצויים', '\\bseverance\\b'),
  total: /סה"כ/u,
  payslip: re('תלוש', 'משכורת', 'שכר', 'ברוטו', 'נטו', '\\b(?:payslip|pay\\s+slip|salary)\\b')
};
const P = PAYSLIP_PATTERNS;

/** The printed label of each field (a candidate whose label does not match is only ever "for review"). */
export const FIELD_LABEL: Record<PayslipField, RegExp> = {
  base_salary: P.base, commissions: P.commissions, bonus: P.bonus, employee_pension_percent: P.pension,
  employee_study_fund_percent: P.study, tax_credit_points: P.credit, current_participation: P.participation
};
/**
 * Labels of other payslip components that are never the field, whatever the layout or the model says: totals and
 * gross, net, overtime and allowances, cumulative figures, balances, the car benefit and its gross-up.
 */
/** Document titles and page numbers ("דוח שכר חודשי — 08/2026 — עמוד 2 מתוך 2") are never a field's row. */
const DOCUMENT = [he('דוח'), he('תלוש'), he('עמוד'), '\\bpage\\b', '\\bpay\\s*slip\\b'];
export const FIELD_LABEL_EXCLUDE: Record<PayslipField, RegExp> = {
  base_salary: re(P.gross.source, P.grossUp.source, P.cumulative.source, 'לקופה', 'מבוטח', 'לפיצויים', 'לשעה', 'שעתי', 'שעות', 'מינימום', 'ממוצע',
    'ביטוח לאומי', 'לצורך', 'ב\\.ל', 'ברוטו', 'חייב', 'נטו', 'סך', 'סה"כ', 'תשלומי', 'משמרת', 'נסיע', 'החזר', 'כלכלה', 'ארוח', 'אש"ל', 'הפרשי', 'הפרשים',
    '\\b(?:overtime|net|hourly|rate|total|gross|shift|travel|retro\\w*)\\b', ...DOCUMENT),
  commissions: re(P.cumulative.source, ...DOCUMENT), bonus: re(P.cumulative.source, ...DOCUMENT),
  employee_pension_percent: re(P.cumulative.source, ...DOCUMENT), employee_study_fund_percent: re(P.cumulative.source, ...DOCUMENT),
  tax_credit_points: re('יתר', 'חופש', 'מחלה', 'הבראה', he('ימי'), 'שעות', P.cumulative.source, '\\b(?:balance|leave|vacation|sick)\\b', ...DOCUMENT),
  current_participation: re(P.participationExclude.source, P.carBenefit.source, P.cumulative.source, ...DOCUMENT)
};

// "Gross" describes an explicitly identified base row too. Accept only these complete labels;
// totals, gross-up, cumulative amounts, hourly pay and ambiguous combined rows remain excluded.
// A trailing currency note ("(ILS)", "(₪)") belongs to the same label.
const EXPLICIT_GROSS_BASE = /^(?:(?:שכר|משכורת)\s+(?:בסיס|יסוד)\s+(?:ברוטו|\(ברוטו\))|gross\s+(?:base|basic)\s+(?:salary|pay|wage)|(?:base|basic)\s+gross\s+(?:salary|pay|wage)|(?:base|basic)\s+(?:salary|pay|wage)\s+(?:gross|\(gross\)))(?:\s*\((?:ILS|NIS|₪|ש"ח)\))?$/iu;
export function isExcludedFieldLabel(field: PayslipField, label: string): boolean {
  return !(field === 'base_salary' && EXPLICIT_GROSS_BASE.test(normalize(label))) && FIELD_LABEL_EXCLUDE[field].test(label);
}

/** Where a row is printed, when the reader knows it (visual reading reports it; text reading does not). */
export const SECTIONS = ['earnings', 'deductions', 'employer_contributions', 'contributions_table', 'tax_details', 'balances', 'totals', 'other'] as const;
export type Section = typeof SECTIONS[number];
/** Sections a field is never printed in. */
export const FIELD_SECTION_EXCLUDE: Record<PayslipField, Section[]> = {
  base_salary: ['deductions', 'employer_contributions', 'contributions_table', 'tax_details', 'balances', 'totals'],
  commissions: ['deductions', 'employer_contributions', 'contributions_table', 'tax_details', 'balances', 'totals'],
  bonus: ['deductions', 'employer_contributions', 'contributions_table', 'tax_details', 'balances', 'totals'],
  employee_pension_percent: ['earnings', 'tax_details', 'balances', 'totals'],
  employee_study_fund_percent: ['earnings', 'tax_details', 'balances', 'totals'],
  tax_credit_points: ['earnings', 'deductions', 'employer_contributions', 'contributions_table', 'balances', 'totals'],
  current_participation: ['employer_contributions', 'contributions_table', 'tax_details', 'balances', 'totals']
};

type Token = { value: number; raw: string; percent: boolean };
/**
 * Numbers as printed: "15,000.00", "6.00%", "%6", "900.00-" (a deduction). Never an amount: digits glued to letters
 * (codes, model names), parts of a date ("07/2026", "01/01/2024"), and integers with a leading zero ("00", "05"),
 * which are codes, date parts or a value cut off at the page edge. Text extraction can glue a Hebrew label to its
 * amount ("שכר יסוד חודשי18,500.00"): after a Hebrew letter only a formatted amount (thousands separator or two
 * decimals) or a percentage counts, never a bare integer (a code).
 */
export function tokens(text: string): Token[] {
  const found: Token[] = [];
  for (const match of text.matchAll(/(%\s*)?-?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?-?(\s*%)?/g)) {
    const before = text.slice(Math.max(0, match.index! - 1), match.index!);
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 1);
    const formatted = Boolean(match[1] || match[4]) || match[2].includes(',') || match[3]?.length === 2;
    if (/[A-Za-z/.]/.test(before) || (/\p{Script=Hebrew}/u.test(before) && !formatted) || /[A-Za-z/]/.test(after)) continue;
    if (/^0\d/.test(match[2]) && !match[3]) continue;
    const value = Number(match[2].replace(/,/g, '') + (match[3] ? `.${match[3]}` : ''));
    if (!Number.isFinite(value)) continue;
    found.push({ value, raw: match[0].trim(), percent: Boolean(match[1] || match[4]) });
  }
  return found;
}

export const evidenceOf = (label: string, raw?: string) => maskIdentifiers(`${normalize(label).slice(0, 40)}${raw ? ` · ${raw}` : ''}`).slice(0, 120);
export const fmt = (value: number) => value.toLocaleString('he-IL');
export const CREDIT_ABBREVIATION_WARNING = 'בתלוש כתוב בקיצור (נ"ז). כדאי לוודא שזה מספר נקודות הזיכוי שלך.';
export const COMBINED_SALARY_WARNING = 'בתלוש כתוב "שכר משולב", שעשוי לכלול גם שעות נוספות או רכיבים אחרים. כדאי לוודא שזה שכר הבסיס.';
export const BONUS_RECURRENCE_UNCLEAR = 'לא כתוב בתלוש שהבונוס קבוע. כדאי לוודא שהוא משולם כל חודש, ולא חד־פעמי.';
export const oneTimeNote = (label: string, value: number) =>
  `בתלוש מופיע תשלום שנראה חד־פעמי (${normalize(label).slice(0, 30)}: ${fmt(value)} ₪). הוא לא נכלל כבונוס חודשי. אם זה בונוס קבוע, אפשר להזין אותו.`;

/**
 * Whether a bonus row is recurring, from its printed label first: explicit one-time words win, then explicit
 * recurring words, then "מענק" (a grant is one-time unless printed as recurring). Without printed evidence a reader's
 * hint can only exclude a row (one_time) or leave it unclear: a claim of "recurring" alone is never established.
 */
export function bonusRecurrence(label: string, hint?: string): 'recurring' | 'one_time' | 'unclear' {
  if (P.oneTime.test(label)) return 'one_time';
  if (P.recurring.test(label)) return 'recurring';
  if (P.grant.test(label) || hint === 'one_time') return 'one_time';
  return 'unclear';
}

/** A row that may be the field: its value, printed label and value, page, and why it needs review (if it does). */
export type FieldCandidate = { value: number; label: string; raw: string; page: number; warnings?: string[] };
/** A row that was considered and refused, with the reason shown to the employee; `unclear` rows make the field ambiguous. */
export type FieldRejection = { note: string; unclear?: boolean };
export type ResolvedField = { value: number | null; evidence?: string; page: number; review: boolean; warnings: string[]; ambiguous?: boolean };

/**
 * The field from its candidates. One supported value (however many rows repeat it) is suggested; different values
 * are never chosen between (ambiguous); with no candidate, the most informative refusal is shown instead of a value.
 */
export function resolveField(accepted: FieldCandidate[], rejected: FieldRejection[], what: string): ResolvedField {
  const notes = [...new Set(rejected.map(item => item.note))];
  const unclear = rejected.filter(item => item.unclear);
  if (!accepted.length) {
    return { value: null, page: 1, review: true, warnings: notes.length ? notes.slice(0, 2) : ['לא נמצא בתלוש.'], ...(unclear.length ? { ambiguous: true } : {}) };
  }
  // A row whose value could not be read cleanly may be the real one: a clean row elsewhere does not settle it.
  if (unclear.length) return { value: null, page: accepted[0].page, review: true, ambiguous: true, warnings: [...new Set(unclear.map(item => item.note))].slice(0, 2) };
  const distinct = [...new Set(accepted.map(item => item.value))];
  if (distinct.length > 1) {
    return { value: null, page: accepted[0].page, review: true, ambiguous: true,
      warnings: [`נמצאו כמה שורות של ${what} עם ערכים שונים (${distinct.slice(0, 4).map(fmt).join(', ')}), אז לא בחרתי אחת.`] };
  }
  const first = accepted[0];
  const warnings = [...new Set(accepted.flatMap(item => item.warnings ?? []))];
  return { value: first.value, evidence: evidenceOf(first.label, first.raw), page: first.page, review: warnings.length > 0, warnings };
}
