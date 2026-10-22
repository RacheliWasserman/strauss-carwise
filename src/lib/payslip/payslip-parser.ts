import { PAYSLIP_FIELD_ORDER, type ExtractedField, type PayslipField } from './payslip-contract';
import type { DocumentLine } from './payslip-file';
import {
  bonusRecurrence, BONUS_RECURRENCE_UNCLEAR, COMBINED_SALARY_WARNING, CREDIT_ABBREVIATION_WARNING, evidenceOf, FIELD_LABEL, FIELD_LABEL_EXCLUDE, fmt,
  isExcludedFieldLabel, normalize, oneTimeNote, PAYSLIP_PATTERNS, resolveField, reverseHebrewRuns, reverseWordOrder, tokens,
  type FieldCandidate, type FieldRejection, type ResolvedField
} from './payslip-rules';

export { COMBINED_SALARY_WARNING, CREDIT_ABBREVIATION_WARNING, evidenceOf, normalize, PAYSLIP_PATTERNS, reverseHebrewRuns, reverseWordOrder, tokens } from './payslip-rules';

/**
 * Deterministic reader for the text of an Israeli payslip (digital PDF or DOCX). It collects candidate rows (a printed
 * label and the numbers that belong to it, by row, table column or label-above-value position) and leaves every
 * decision to the shared rules (`payslip-rules.ts`): it never fills a missing value, never converts an amount to a
 * percentage, never chooses between conflicting values, and never takes an employer's contribution, a total, a
 * cumulative figure or a taxable car benefit in place of the employee's own value. Document text is data only.
 */

const P = PAYSLIP_PATTERNS;
const LABELS: Array<[keyof typeof P, PayslipField | 'gross' | 'carBenefit']> = [['base', 'base_salary'], ['commissions', 'commissions'], ['bonus', 'bonus'],
  ['study', 'employee_study_fund_percent'], ['pension', 'employee_pension_percent'], ['credit', 'tax_credit_points'],
  ['participation', 'current_participation'], ['carBenefit', 'carBenefit'], ['gross', 'gross']];

type Cell = { text: string; x?: number };
/** `inferred`: a label and a value printed on separate lines and paired by column (cards, single-column portals). */
type Line = { cells: Cell[]; page: number; text: string; inferred?: boolean };
const hasHebrew = (text: string) => /\p{Script=Hebrew}/u.test(text);
/** A whole cell that only says how the row is paid; never a label of its own. */
const ROW_NOTE = /^(?:ניכוי(?:\s+(?:מ|מה)?(?:נטו|שכר))?|(?:מ|מה)נטו|חודשי(?:ת)?|קבוע(?:ה)?|deduct(?:ion|ed)?(?:\s+from\s+net)?|monthly|fixed)$/iu;
const STACKED_WARNING = 'הערך הופיע מתחת לתווית ולא באותה שורה. כדאי לוודא שהוא שייך לה.';

/**
 * The label cell for a pattern and the printed numbers that follow it, up to the next text cell (a parallel table).
 * `head` is the label cell up to its first digit: what the row says it is, used for every exclusion rule.
 */
function segmentAfter(line: Line, pattern: RegExp) {
  const index = line.cells.findIndex(cell => pattern.test(cell.text));
  if (index < 0) return null;
  const cell = line.cells[index].text;
  const match = cell.match(pattern)!;
  const sameCell = cell.slice(match.index! + match[0].length);
  const digit = cell.search(/\d/);
  const head = digit < 0 ? cell : cell.slice(0, digit);
  // Evidence is the printed label only: the whole cell when it is just a label, else the matched words.
  const firstDigit = cell.slice(match.index!).search(/\d/);
  const label = !/\d/.test(cell) && cell.length <= 40 ? cell
    : cell.slice(match.index!, firstDigit < 0 ? undefined : match.index! + firstDigit).slice(0, 40).replace(/^[^\p{L}]+|[^\p{L}"']+$/gu, '');
  const following: Cell[] = [];
  for (const cell of line.cells.slice(index + 1)) {
    // A cell with words is the next label (e.g. a deductions table printed beside the payments table), except a
    // note on how the row is paid ("ניכוי מהנטו") printed between the label and its amount.
    const bare = cell.text.replace(/ש"ח|₪|%|שקלים|ש'|\b(?:NIS|ILS)\b/giu, '');
    if (!following.length && ROW_NOTE.test(cell.text)) continue;
    if (hasHebrew(bare) || /[A-Za-z]{3,}/.test(bare)) break;
    following.push(cell);
  }
  const text = [sameCell, ...following.map(cell => cell.text)].join(' | ');
  return { index, label, cell, head, sameCell, following, text, tokens: tokens(text) };
}

/**
 * The columns of the table header above a row that hold year-to-date / cumulative figures (e.g. "מצטבר מתחילת שנה"),
 * by horizontal position (PDF) and by position from the row's end (DOCX). Only the nearest header counts.
 */
function cumulativeColumns(lines: Line[], at: number) {
  for (let index = at - 1; index >= Math.max(0, at - 25) && lines[index].page === lines[at].page; index--) {
    const header = lines[index];
    if (header.inferred || header.cells.length < 3 || /\d/.test(header.text)) continue;
    return header.cells.flatMap((cell, position) => P.cumulative.test(cell.text) ? [{ x: cell.x, fromEnd: header.cells.length - position }] : []);
  }
  return [];
}
/** The printed numbers of a row segment, without those in cumulative columns. */
function currentTokens(lines: Line[], at: number, segment: NonNullable<ReturnType<typeof segmentAfter>>) {
  const columns = cumulativeColumns(lines, at);
  if (!columns.length) return segment.tokens;
  const row = lines[at];
  const kept = segment.following.filter(cell => !columns.some(column => cell.x !== undefined && column.x !== undefined
    ? Math.abs(cell.x - column.x) <= 45 : row.cells.length - row.cells.indexOf(cell) === column.fromEnd));
  return tokens([segment.sameCell, ...kept.map(cell => cell.text)].join(' | '));
}

type Row = FieldCandidate & { head: string };
/** Money rows for a label: the row's amount is its last current-month number (after quantity and rate). */
function amountRows(lines: Line[], pattern: RegExp, exclude?: { test: (label: string) => boolean }): Row[] {
  const rows: Row[] = [];
  for (const [at, line] of lines.entries()) {
    const segment = segmentAfter(line, pattern);
    if (!segment || exclude?.test(segment.head)) continue;
    const amounts = currentTokens(lines, at, segment).filter(token => !token.percent);
    if (!amounts.length) continue;
    const last = amounts.at(-1)!;
    rows.push({ value: last.value, label: segment.label, raw: last.raw, page: line.page, head: segment.head, warnings: line.inferred ? [STACKED_WARNING] : [] });
  }
  return rows;
}
const fieldRows = (lines: Line[], field: PayslipField) => amountRows(lines, FIELD_LABEL[field], { test: label => isExcludedFieldLabel(field, label) });

/* ---------- Contribution percentages (pension / study fund) ---------- */

type Header = { page: number; index: number; employeePercent?: Cell & { position: number }; employeeAmount?: Cell & { position: number }; size: number };
function headerOf(line: Line, index: number): Header | null {
  const cells = line.cells;
  const isEmployee = (cell: Cell) => P.employee.test(cell.text) && !P.employer.test(cell.text);
  if (!cells.some(isEmployee) || !cells.some(cell => P.employer.test(cell.text) || P.severance.test(cell.text))) return null;
  const percent = cells.findIndex(cell => isEmployee(cell) && /%|אחוז|שיעור|rate/iu.test(cell.text));
  const amount = cells.findIndex(cell => isEmployee(cell) && !/%|אחוז|שיעור|rate/iu.test(cell.text));
  return { page: line.page, index, size: cells.length,
    ...(percent >= 0 ? { employeePercent: { ...cells[percent], position: percent } } : {}),
    ...(amount >= 0 ? { employeeAmount: { ...cells[amount], position: amount } } : {}) };
}
/** The row cell in a header's column: by horizontal position (PDF), else by position from the row's end (DOCX). */
function cellInColumn(row: Line, header: Header, column: Cell & { position: number }) {
  if (column.x !== undefined && row.cells.every(cell => cell.x !== undefined)) {
    const nearest = [...row.cells].sort((a, b) => Math.abs(a.x! - column.x!) - Math.abs(b.x! - column.x!))[0];
    return nearest && Math.abs(nearest.x! - column.x!) <= 45 ? nearest : undefined;
  }
  const fromEnd = header.size - column.position;
  return row.cells.length === header.size ? row.cells[column.position] : row.cells[row.cells.length - fromEnd];
}

function contribution(lines: Line[], kind: 'pension' | 'study'): ResolvedField {
  const label = kind === 'pension' ? P.pension : P.study;
  const about = kind === 'pension' ? 'פנסיה' : 'קרן השתלמות';
  const field = kind === 'pension' ? 'employee_pension_percent' : 'employee_study_fund_percent';
  const matches = (line: Line) => label.test(line.text) && (kind === 'study' || !P.study.test(line.text)) && !FIELD_LABEL_EXCLUDE[field].test(line.text);
  const found: Array<{ value: number; label: string; raw: string; page: number; review: boolean; warning?: string }> = [];
  const amountsOnly: number[] = [];
  let employerOnly = false;
  // 1. A contributions table: header with employee and employer columns, rows per fund.
  lines.forEach((line, index) => {
    const header = headerOf(line, index);
    if (!header) return;
    for (const row of lines.slice(index + 1, index + 12)) {
      if (row.page !== line.page || headerOf(row, 0)) break;
      if (row.inferred || !matches(row)) continue;
      const name = row.cells.find(cell => label.test(cell.text))?.text ?? about;
      const percentCell = header.employeePercent && cellInColumn(row, header, header.employeePercent);
      const value = percentCell ? tokens(percentCell.text).filter(token => token.value <= 100) : [];
      if (value.length === 1) { found.push({ value: value[0].value, label: name, raw: `${value[0].raw.replace('%', '')}%`, page: row.page, review: false }); continue; }
      const amountCell = header.employeeAmount && cellInColumn(row, header, header.employeeAmount);
      const amount = amountCell ? tokens(amountCell.text) : [];
      if (amount.length === 1) amountsOnly.push(amount[0].value);
    }
  });
  // 2. Inline rows: "הפרשת עובד לפנסיה 6%", "פנסיה עובד 6% מעביד 6.5%" (also a label above its value).
  //    Severance (פיצויים) is funded by the employer: a severance row without an employee word is never the rate.
  if (!found.length) for (const line of lines) {
    if (!matches(line) || headerOf(line, 0) || (P.severance.test(line.text) && !P.employee.test(line.text))) continue;
    // A unit printed in the label ("Employee pension contribution (%)") applies to the bare number right after it.
    const text = line.cells.map((cell, k) => {
      const previous = line.cells[k - 1]?.text ?? '';
      return /^\d{1,2}(?:\.\d{1,2})?$/.test(cell.text) && /\(%\)$|[^\d\s]\s*%$/u.test(previous) && !/\d/.test(previous) ? `${cell.text}%` : cell.text;
    }).join(' | ');
    const percents = [...text.matchAll(/(?<![\d.,])()(\d{1,2}(?:\.\d{1,2})?)\s*%/g), ...text.matchAll(/(%\s*)(\d{1,2}(?:\.\d{1,2})?)(?![\d.,])/g)]
      .map(match => ({ value: Number(match[2]), at: match.index! + match[1].length, raw: `${match[2]}%` }))
      .filter((item, position, all) => all.findIndex(other => other.at === item.at) === position);
    const employeeAt = [...text.matchAll(new RegExp(P.employee.source, 'giu'))].map(match => match.index!);
    const employerAt = [...text.matchAll(new RegExp(P.employer.source, 'giu'))].map(match => match.index!);
    if (!percents.length) {
      if (employeeAt.length && !employerAt.length) {
        const amount = tokens(text).filter(token => !token.percent && token.value >= 1).at(-1);
        if (amount) amountsOnly.push(amount.value);
      }
      continue;
    }
    if (!employeeAt.length && employerAt.length) { employerOnly = true; continue; }
    if (!employeeAt.length) {
      if (percents.length === 1) found.push({ value: percents[0].value, label: about, raw: percents[0].raw, page: line.page, review: true,
        warning: `בשורה לא כתוב שזה חלק העובד. כדאי לבדוק שזה האחוז שמנוכה מהשכר שלך ולא הפרשת המעביד.` });
      continue;
    }
    // Each percentage belongs to the nearest role word before it (in reading order); else the nearest after it.
    for (const item of percents) {
      const before = [...employeeAt.map(at => ({ at, role: 'employee' })), ...employerAt.map(at => ({ at, role: 'employer' }))]
        .filter(role => role.at < item.at).sort((a, b) => b.at - a.at)[0];
      const after = [...employeeAt.map(at => ({ at, role: 'employee' })), ...employerAt.map(at => ({ at, role: 'employer' }))]
        .filter(role => role.at > item.at).sort((a, b) => a.at - b.at)[0];
      const role = (before ?? after)?.role;
      if (role === 'employee') found.push({ value: item.value, label: about, raw: item.raw, page: line.page, review: !before || Boolean(line.inferred),
        ...(line.inferred ? { warning: STACKED_WARNING } : {}) });
    }
  }
  const distinct = [...new Set(found.map(item => item.value))];
  if (distinct.length > 1) {
    return { value: null, page: found[0].page, review: true, ambiguous: true,
      warnings: [`נמצאו כמה אחוזי ${about} שונים לעובד (${distinct.slice(0, 4).map(value => `${fmt(value)}%`).join(', ')}). כדאי לבדוק איזה מהם נכון.`] };
  }
  if (found.length) {
    const first = found[0];
    const labelText = first.label.length > 40 ? about : first.label;
    return { value: first.value, evidence: evidenceOf(`${labelText} (עובד)`, first.raw), page: first.page, review: found.some(item => item.review),
      warnings: found.flatMap(item => item.warning ? [item.warning] : []).slice(0, 1) };
  }
  const warnings: string[] = [];
  if (amountsOnly.length) warnings.push(`בתלוש מופיע ניכוי עובד ל${about} של ${fmt(amountsOnly[0])} ₪, אבל לא אחוז. לא חישבתי ממנו אחוז, כי בסיס ההפרשה בתלוש שונה. אפשר להזין את האחוז ידנית או לסמן "לא ידוע".`);
  else if (employerOnly) warnings.push(`מצאתי רק את הפרשת המעביד ל${about}, ולא את חלק העובד.`);
  else warnings.push('לא נמצא בתלוש.');
  return { value: null, page: 1, review: true, warnings };
}

/* ---------- The whole document ---------- */

function asLines(lines: DocumentLine[], transform: (text: string) => string): Line[] {
  return lines.map(line => {
    let cells = line.cells.map(cell => ({ ...cell, text: transform(normalize(cell.text)) })).filter(cell => cell.text);
    // PDF rows are ordered right to left (Hebrew); a row with no Hebrew at all (an English label) reads left to right.
    if (cells.every(cell => cell.x !== undefined) && !cells.some(cell => hasHebrew(cell.text)) && cells.some(cell => /[A-Za-z]{3,}/.test(cell.text))) {
      cells = [...cells].sort((a, b) => a.x! - b.x!);
    }
    return { page: line.page, cells, text: cells.map(cell => cell.text).join(' | ') };
  }).filter(line => line.cells.length && !P.identifier.test(line.text.replace(/סה"כ/g, '')) || hasLabel(line));
}
const hasLabel = (line: Line) => LABELS.some(([key]) => P[key].test(line.text));
const labelHits = (lines: Line[]) => lines.reduce((sum, line) => sum + LABELS.filter(([key]) => P[key].test(line.text)).length, 0);

/**
 * Single-column and card layouts print a line of labels and, directly below it, a line of their values. Each label
 * is paired with the value in its column (same count, and close horizontally when positions are known); the pairs
 * are added as inferred rows, so their values are always for review. A value line may also hold text values
 * ("קבוצה ג" under "קבוצת זכאות"): only its numeric cells are paired, and never when it holds a field label itself.
 */
function withStackedPairs(lines: Line[]): Line[] {
  const isLabel = (cell: Cell) => /\p{L}/u.test(cell.text) && !/\d/.test(cell.text);
  const isValue = (cell: Cell) => /\d/.test(cell.text) && !/\p{L}/u.test(cell.text.replace(/ש"ח|₪|ש'|NIS|ILS/giu, ''));
  return lines.flatMap((line, index) => {
    const labels = lines[index - 1];
    if (!labels || labels.page !== line.page || !labels.cells.every(isLabel) || labels.cells.length !== line.cells.length) return [line];
    if (!line.cells.every(isValue) && (!line.cells.some(isValue) || hasLabel(line))) return [line];
    const columns = line.cells.flatMap((cell, k) => isValue(cell) ? [k] : []);
    const positioned = labels.cells.every(cell => cell.x !== undefined) && line.cells.every(cell => cell.x !== undefined);
    if (positioned && columns.some(k => Math.abs(labels.cells[k].x! - line.cells[k].x!) > 150)) return [line];
    return [line, ...columns.map((k): Line => ({ page: line.page, cells: [labels.cells[k], line.cells[k]], text: `${labels.cells[k].text} | ${line.cells[k].text}`, inferred: true }))];
  });
}

export type ParsedPayslip = { fields: ExtractedField[]; warnings: string[]; found: number; looksLikePayslip: boolean };

/**
 * The text as stored, with reversed letters, or with reversed word order: the reading in which the most payslip
 * labels are recognized wins (ties keep the text as stored). A repaired reading puts every value up for review.
 */
const READINGS = [
  { transform: (text: string) => text, warning: null },
  { transform: reverseHebrewRuns, warning: 'הטקסט בקובץ נשמר בסדר הפוך ותוקן אוטומטית. כדאי לבדוק כל ערך.' },
  { transform: reverseWordOrder, warning: 'סדר המילים בקובץ נשמר הפוך ותוקן אוטומטית. כדאי לבדוק כל ערך.' }
];

export function parsePayslipLines(input: DocumentLine[]): ParsedPayslip {
  const readings = READINGS.map(reading => ({ ...reading, lines: asLines(input, reading.transform) }));
  const best = readings.reduce((chosen, reading) => labelHits(reading.lines) > labelHits(chosen.lines) ? reading : chosen);
  const lines = withStackedPairs(best.lines);
  const useReversed = best.warning !== null;
  const documentWarnings: string[] = [];
  if (best.warning) documentWarnings.push(best.warning);

  const candidates = {} as Record<PayslipField, ResolvedField>;
  const bases = fieldRows(lines, 'base_salary').map(row => P.combined.test(row.head) ? { ...row, warnings: [...row.warnings!, COMBINED_SALARY_WARNING] } : row);
  candidates.base_salary = resolveField(bases, [], 'שכר בסיס');
  candidates.commissions = resolveField(fieldRows(lines, 'commissions'), [], 'עמלות');

  // Bonus: every bonus-like row is a candidate on its own. A one-time row is excluded (and reported) without
  // affecting a separate recurring row; a row whose recurrence is not printed is suggested for review only.
  const bonuses: FieldCandidate[] = [];
  const oneTime: FieldRejection[] = [];
  for (const row of fieldRows(lines, 'bonus')) {
    const recurrence = bonusRecurrence(row.head);
    if (recurrence === 'one_time') oneTime.push({ note: oneTimeNote(row.label, row.value) });
    // A printed zero is no bonus at all: whether it recurs is irrelevant.
    else bonuses.push(recurrence === 'recurring' || row.value === 0 ? row : { ...row, warnings: [...row.warnings!, BONUS_RECURRENCE_UNCLEAR] });
  }
  candidates.bonus = resolveField(bonuses, oneTime, 'בונוס');

  candidates.employee_pension_percent = contribution(lines, 'pension');
  candidates.employee_study_fund_percent = contribution(lines, 'study');

  // Credit points: a small number next to its label (the row may also show their value in shekels). A row with more
  // than one such number (e.g. 2.75 beside 2.92) is unclear, and makes the field ambiguous.
  const credits: FieldCandidate[] = [];
  const unclearCredits: FieldRejection[] = [];
  for (const [at, line] of lines.entries()) {
    const segment = segmentAfter(line, P.credit);
    if (!segment || FIELD_LABEL_EXCLUDE.tax_credit_points.test(segment.head)) continue;
    const values = currentTokens(lines, at, segment).filter(token => !token.percent && token.value <= 20 && /^\d+(?:\.\d{1,2})?$/.test(token.raw.replace(/-/g, '')));
    if (!values.length) continue;
    const distinct = [...new Set(values.map(token => token.value))];
    if (distinct.length > 1) { unclearCredits.push({ note: `ליד נקודות הזיכוי מופיעים כמה מספרים (${distinct.slice(0, 4).map(fmt).join(', ')}), אז לא בחרתי אחד.`, unclear: true }); continue; }
    const short = !/זיכוי/u.test(segment.label) && P.creditShort.test(segment.label);
    credits.push({ value: values[0].value, label: segment.label, raw: values[0].raw, page: line.page,
      warnings: [...(line.inferred ? [STACKED_WARNING] : []), ...(short ? [CREDIT_ABBREVIATION_WARNING] : [])] });
  }
  candidates.tax_credit_points = resolveField(credits, unclearCredits, 'נקודות זיכוי');

  // Car participation is what the employee pays. The taxable car benefit (שווי שימוש), its gross-up or imputation,
  // fuel, and totals that include the car ("סך ניכויים כולל השתתפות רכב") are never used in its place.
  const benefit = amountRows(lines, P.carBenefit);
  candidates.current_participation = resolveField(fieldRows(lines, 'current_participation'),
    benefit.length ? [{ note: `בתלוש מופיע שווי שימוש ברכב (${fmt(benefit[0].value)} ₪). זה שווי לצורכי מס, ולא ההשתתפות שלך, ולכן לא העתקתי אותו.` }] : [], 'השתתפות ברכב');

  // Consistency with the total gross (used for checking only, never stored).
  const gross = amountRows(lines, P.gross, P.cumulative).map(item => item.value);
  const total = gross.length ? Math.max(...gross) : null;
  const base = candidates.base_salary.value;
  if (base === null && !candidates.base_salary.ambiguous && total !== null) candidates.base_salary.warnings = [`מצאתי רק סה״כ ברוטו (${fmt(total)} ₪), שאינו שכר הבסיס.`];
  if (total !== null && base !== null) {
    const sum = base + (candidates.commissions.value ?? 0) + (candidates.bonus.value ?? 0);
    if (sum > total + 1) {
      for (const field of ['base_salary', 'commissions', 'bonus'] as const) if (candidates[field].value !== null) {
        candidates[field].review = true;
        candidates[field].warnings.push(`יחד עם שאר הרכיבים הסכום גבוה מסה״כ התשלומים בתלוש (${fmt(total)} ₪). כדאי לבדוק.`);
      }
    } else if (base === total && ((candidates.commissions.value ?? 0) > 0 || (candidates.bonus.value ?? 0) > 0)) {
      candidates.base_salary.review = true;
      candidates.base_salary.warnings.push('שכר הבסיס שווה לסה״כ הברוטו למרות שיש רכיבים נוספים. ייתכן שזה ברוטו כולל.');
    }
  }

  const fields: ExtractedField[] = PAYSLIP_FIELD_ORDER.map(field => {
    const item = candidates[field];
    return { field, value: item.value, ...(item.evidence ? { evidence: item.evidence } : {}), ...(item.value !== null ? { page: item.page } : {}),
      ...(item.value === null && item.ambiguous ? { ambiguous: true as const } : {}),
      confidence: item.value !== null && !item.review && !useReversed ? 'high' : 'review', warnings: item.warnings.map(text => text.slice(0, 200)).slice(0, 4) };
  });
  const found = fields.filter(item => item.value !== null).length;
  return { fields, warnings: documentWarnings, found, looksLikePayslip: lines.some(line => P.payslip.test(line.text)) };
}
