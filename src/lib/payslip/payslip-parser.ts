import { maskIdentifiers, PAYSLIP_FIELD_ORDER, type ExtractedField, type PayslipField } from './payslip-contract';
import type { DocumentLine } from './payslip-file';

/**
 * Deterministic reader for the text of an Israeli payslip (digital PDF or DOCX). It returns only values it can tie
 * to a printed label, with that label as evidence. It never fills a missing value, never converts an amount to a
 * percentage, and never takes an employer's contribution, a total gross or a taxable car benefit in place of the
 * employee's own value. Document text is data only: nothing in it is followed as an instruction.
 */

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩֑-ׇ]/g;
export const normalize = (text: string) => text.replace(BIDI_MARKS, '').replace(/[״“”„]/g, '"').replace(/[׳’‘`]/g, "'").replace(/\s+/g, ' ').trim();
/** Visual-order PDFs store each Hebrew phrase reversed ("דוסי רכש"); this restores logical order. */
export const reverseHebrewRuns = (text: string) =>
  text.replace(/[\p{Script=Hebrew}"'][\p{Script=Hebrew}"' ]*[\p{Script=Hebrew}"']|[\p{Script=Hebrew}]/gu, run => [...run].reverse().join(''));

const word = (pattern: string) => new RegExp(`(?:^|[^\\p{L}])(?:${pattern})(?=$|[^\\p{L}])`, 'u');
export const PAYSLIP_PATTERNS = {
  base: /(?:שכר|משכורת)\s+(?:יסוד|בסיס)|(?:^|[^\p{L}])(?:שכר|משכורת)\s+חודשי(?:ת)?(?=$|[^\p{L}])/u,
  baseExclude: /לקופה|מבוטח|לפיצויים|שעה|שעתי|מינימום|ממוצע|ביטוח לאומי|לצורך|ברוטו|ב\.ל/u,
  commissions: word('[והבל]?(?:עמלות|עמלה|עמלת)'),
  bonus: word('[והבל]?(?:בונוס|בונוסים|פרמיה|פרמיות|מענק|תמריץ|תמריצים)'),
  oneTime: /מענק|חד[- ]?פעמי|שנתי|רבעוני|(?:^|[^\p{L}])חג|יובל|הוקרה|מיוחד|הפרשים|רטרו/u,
  pension: /פנסי|תגמולים|קופ"?ג|קופת גמל|ביטוח מנהלים|(?:^|[^\p{L}])גמל(?=$|[^\p{L}])/u,
  study: /השתלמות|קה"ש|קרן השת/u,
  credit: /נק(?:ודות|ודת|'|\.)?\s*(?:ה)?זיכוי/u,
  participation: /(?:השתתפות|השתת'|ניכוי)[^|]{0,20}רכב/u,
  carBenefit: /שווי\s*(?:שימוש\s*)?(?:ב|ה)?רכב|שווי רכב/u,
  gross: /סה"כ\s*(?:תשלומים|ברוטו)|שכר ברוטו|(?:^|[^\p{L}])ברוטו\s+(?:למס|לב"ל)|סה"כ\s+שכר/u,
  identifier: /ת\.?ז|ת"ז|זהות|חשבון|בנק|סניף|IBAN|כתובת|מיקוד/iu,
  employee: word('[הלמ]?(?:עובד|עובדת|עובדים)|חלק\\s+העובד'),
  employer: /מעביד|מעסיק/u,
  severance: /פיצויים/u,
  total: /סה"כ/u,
  payslip: /תלוש|משכורת|שכר|ברוטו|נטו/u
};
const P = PAYSLIP_PATTERNS;
const LABELS: Array<[keyof typeof P, PayslipField | 'gross' | 'carBenefit']> = [['base', 'base_salary'], ['commissions', 'commissions'], ['bonus', 'bonus'],
  ['study', 'employee_study_fund_percent'], ['pension', 'employee_pension_percent'], ['credit', 'tax_credit_points'],
  ['participation', 'current_participation'], ['carBenefit', 'carBenefit'], ['gross', 'gross']];

type Token = { value: number; raw: string; percent: boolean };
/** Numbers as printed: "15,000.00", "6.00%", "%6", "900.00-" (a deduction). */
export function tokens(text: string): Token[] {
  const found: Token[] = [];
  for (const match of text.matchAll(/(%\s*)?-?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?-?(\s*%)?/g)) {
    const before = text.slice(Math.max(0, match.index! - 1), match.index!);
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 1);
    // Digits glued to letters are codes or model names, never amounts.
    if (/[A-Za-z\p{Script=Hebrew}]/u.test(before) || /[A-Za-z]/.test(after)) continue;
    const value = Number(match[2].replace(/,/g, '') + (match[3] ? `.${match[3]}` : ''));
    if (!Number.isFinite(value)) continue;
    found.push({ value, raw: match[0].trim(), percent: Boolean(match[1] || match[4]) });
  }
  return found;
}

type Cell = { text: string; x?: number };
type Line = { cells: Cell[]; page: number; text: string };
type Candidate = { value: number | null; evidence?: string; page: number; review: boolean; warnings: string[] };
export const evidenceOf = (label: string, raw?: string) => maskIdentifiers(`${normalize(label).slice(0, 40)}${raw ? ` · ${raw}` : ''}`).slice(0, 120);
const hasHebrew = (text: string) => /\p{Script=Hebrew}/u.test(text);
const fmt = (value: number) => value.toLocaleString('he-IL');

/** The label cell for a pattern and the printed numbers that follow it, up to the next text cell (a parallel table). */
function segmentAfter(line: Line, pattern: RegExp) {
  const index = line.cells.findIndex(cell => pattern.test(cell.text));
  if (index < 0) return null;
  const cell = line.cells[index].text;
  const match = cell.match(pattern)!;
  const sameCell = cell.slice(match.index! + match[0].length);
  // Evidence is the printed label only: the whole cell when it is just a label, else the matched words.
  const firstDigit = cell.slice(match.index!).search(/\d/);
  const label = !/\d/.test(cell) && cell.length <= 40 ? cell
    : cell.slice(match.index!, firstDigit < 0 ? undefined : match.index! + firstDigit).slice(0, 40).replace(/^[^\p{L}]+|[^\p{L}"']+$/gu, '');
  const following: Cell[] = [];
  for (const cell of line.cells.slice(index + 1)) {
    // A cell with words is the next label (e.g. a deductions table printed beside the payments table).
    if (hasHebrew(cell.text.replace(/ש"ח|₪|%|שקלים|ש'/g, ''))) break;
    following.push(cell);
  }
  const text = [sameCell, ...following.map(cell => cell.text)].join(' | ');
  return { index, label, text, tokens: tokens(text) };
}

function moneyCandidates(lines: Line[], pattern: RegExp, exclude?: RegExp) {
  const found: Array<{ value: number; label: string; raw: string; page: number; text: string; count: number }> = [];
  for (const line of lines) {
    if (exclude?.test(line.text) && !(pattern === P.base && /שכר יסוד|שכר בסיס/u.test(line.text) && !/ברוטו|לקופה/u.test(line.text))) continue;
    const segment = segmentAfter(line, pattern);
    if (!segment) continue;
    const amounts = segment.tokens.filter(token => !token.percent);
    if (!amounts.length) continue;
    // The amount column is the last number of the row (after quantity and rate).
    const last = amounts.at(-1)!;
    found.push({ value: last.value, label: segment.label, raw: last.raw, page: line.page, text: line.text, count: amounts.length });
  }
  return found;
}

function single(field: PayslipField, found: Array<{ value: number; label: string; raw: string; page: number }>, what: string): Candidate {
  const distinct = [...new Set(found.map(item => item.value))];
  if (!found.length) return { value: null, page: 1, review: true, warnings: ['לא נמצא בתלוש.'] };
  if (distinct.length > 1) {
    return { value: null, page: found[0].page, review: true,
      warnings: [`נמצאו כמה שורות של ${what} עם סכומים שונים (${distinct.slice(0, 4).map(fmt).join(', ')}), אז לא בחרתי אחת.`] };
  }
  return { value: found[0].value, evidence: evidenceOf(found[0].label, found[0].raw), page: found[0].page, review: false, warnings: [] };
}

/* ---------- Contribution percentages (pension / study fund) ---------- */

type Header = { page: number; index: number; employeePercent?: Cell & { position: number }; employeeAmount?: Cell & { position: number }; size: number };
function headerOf(line: Line, index: number): Header | null {
  const cells = line.cells;
  const isEmployee = (cell: Cell) => P.employee.test(cell.text) && !P.employer.test(cell.text);
  if (!cells.some(isEmployee) || !cells.some(cell => P.employer.test(cell.text) || P.severance.test(cell.text))) return null;
  const percent = cells.findIndex(cell => isEmployee(cell) && /%|אחוז|שיעור/u.test(cell.text));
  const amount = cells.findIndex(cell => isEmployee(cell) && !/%|אחוז|שיעור/u.test(cell.text));
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

function contribution(lines: Line[], kind: 'pension' | 'study'): Candidate {
  const label = kind === 'pension' ? P.pension : P.study;
  const about = kind === 'pension' ? 'פנסיה' : 'קרן השתלמות';
  const matches = (line: Line) => label.test(line.text) && (kind === 'study' || !P.study.test(line.text));
  const found: Array<{ value: number; label: string; raw: string; page: number; review: boolean; warning?: string }> = [];
  const amountsOnly: number[] = [];
  let employerOnly = false;
  // 1. A contributions table: header with employee and employer columns, rows per fund.
  lines.forEach((line, index) => {
    const header = headerOf(line, index);
    if (!header) return;
    for (const row of lines.slice(index + 1, index + 12)) {
      if (row.page !== line.page || headerOf(row, 0)) break;
      if (!matches(row)) continue;
      const name = row.cells.find(cell => label.test(cell.text))?.text ?? about;
      const percentCell = header.employeePercent && cellInColumn(row, header, header.employeePercent);
      const value = percentCell ? tokens(percentCell.text).filter(token => token.value <= 100) : [];
      if (value.length === 1) { found.push({ value: value[0].value, label: name, raw: `${value[0].raw.replace('%', '')}%`, page: row.page, review: false }); continue; }
      const amountCell = header.employeeAmount && cellInColumn(row, header, header.employeeAmount);
      const amount = amountCell ? tokens(amountCell.text) : [];
      if (amount.length === 1) amountsOnly.push(amount[0].value);
    }
  });
  // 2. Inline rows: "הפרשת עובד לפנסיה 6%", "פנסיה עובד 6% מעביד 6.5%".
  if (!found.length) for (const line of lines) {
    if (!matches(line) || headerOf(line, 0)) continue;
    const text = line.text;
    const percents = [...text.matchAll(/(?<![\d.,])()(\d{1,2}(?:\.\d{1,2})?)\s*%/g), ...text.matchAll(/(%\s*)(\d{1,2}(?:\.\d{1,2})?)(?![\d.,])/g)]
      .map(match => ({ value: Number(match[2]), at: match.index! + match[1].length, raw: `${match[2]}%` }))
      .filter((item, position, all) => all.findIndex(other => other.at === item.at) === position);
    const employeeAt = [...text.matchAll(new RegExp(P.employee.source, 'gu'))].map(match => match.index!);
    const employerAt = [...text.matchAll(/מעביד|מעסיק/gu)].map(match => match.index!);
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
      if (role === 'employee') found.push({ value: item.value, label: about, raw: item.raw, page: line.page, review: !before });
    }
  }
  const distinct = [...new Set(found.map(item => item.value))];
  if (distinct.length > 1) {
    return { value: null, page: found[0].page, review: true,
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
    const cells = line.cells.map(cell => ({ ...cell, text: transform(normalize(cell.text)) })).filter(cell => cell.text);
    return { page: line.page, cells, text: cells.map(cell => cell.text).join(' | ') };
  }).filter(line => line.cells.length && !P.identifier.test(line.text.replace(/סה"כ/g, '')) || hasLabel(line));
}
function hasLabel(line: DocumentLine) {
  const text = line.cells.map(cell => normalize(cell.text)).join(' | ');
  return LABELS.some(([key]) => P[key].test(text));
}
const labelHits = (lines: Line[]) => lines.reduce((sum, line) => sum + LABELS.filter(([key]) => P[key].test(line.text)).length, 0);

export type ParsedPayslip = { fields: ExtractedField[]; warnings: string[]; found: number; looksLikePayslip: boolean };

export function parsePayslipLines(input: DocumentLine[]): ParsedPayslip {
  const logical = asLines(input, text => text);
  const reversed = asLines(input, reverseHebrewRuns);
  const useReversed = labelHits(reversed) > labelHits(logical);
  const lines = useReversed ? reversed : logical;
  const documentWarnings: string[] = [];
  if (useReversed) documentWarnings.push('הטקסט בקובץ נשמר בסדר הפוך ותוקן אוטומטית. כדאי לבדוק כל ערך.');

  const candidates = {} as Record<PayslipField, Candidate>;
  candidates.base_salary = single('base_salary', moneyCandidates(lines, P.base, P.baseExclude), 'שכר בסיס');
  candidates.commissions = single('commissions', moneyCandidates(lines, P.commissions), 'עמלות');
  // Bonus: only a recurring payment counts as the monthly bonus; one-time payments are reported, not used.
  const bonuses = moneyCandidates(lines, P.bonus);
  const recurring = bonuses.filter(item => !P.oneTime.test(item.text));
  const oneTime = bonuses.filter(item => P.oneTime.test(item.text));
  candidates.bonus = single('bonus', recurring, 'בונוס');
  if (candidates.bonus.value !== null) {
    candidates.bonus.review = true;
    candidates.bonus.warnings.push('כדאי לבדוק שזה בונוס שמשולם כל חודש, ולא תשלום חד־פעמי.');
  } else if (oneTime.length && !recurring.length) {
    candidates.bonus.warnings = [`בתלוש מופיע תשלום שנראה חד־פעמי (${normalize(oneTime[0].label).slice(0, 30)}: ${fmt(oneTime[0].value)} ₪). הוא לא נכלל כבונוס חודשי. אם זה בונוס קבוע, אפשר להזין אותו.`];
  }
  candidates.employee_pension_percent = contribution(lines, 'pension');
  candidates.employee_study_fund_percent = contribution(lines, 'study');
  // Credit points: a small number next to its label (the row may also show their value in shekels).
  const credits = lines.flatMap(line => {
    const segment = segmentAfter(line, P.credit);
    const values = segment?.tokens.filter(token => !token.percent && token.value <= 20 && /^\d+(?:\.\d{1,2})?$/.test(token.raw.replace(/-/g, ''))) ?? [];
    return segment && values.length ? [{ value: values[0].value, label: segment.label, raw: values[0].raw, page: line.page }] : [];
  });
  candidates.tax_credit_points = single('tax_credit_points', credits, 'נקודות זיכוי');
  // Car participation is what the employee pays; the taxable car benefit (שווי שימוש) is never used in its place.
  const participation = moneyCandidates(lines.filter(line => !P.carBenefit.test(line.cells.find(cell => P.participation.test(cell.text))?.text ?? '')), P.participation);
  candidates.current_participation = single('current_participation', participation, 'השתתפות ברכב');
  const benefit = moneyCandidates(lines, P.carBenefit);
  if (candidates.current_participation.value === null && benefit.length) {
    candidates.current_participation.warnings = [`בתלוש מופיע שווי שימוש ברכב (${fmt(benefit[0].value)} ₪). זה שווי לצורכי מס, ולא ההשתתפות שלך, ולכן לא העתקתי אותו.`];
  }

  // Consistency with the total gross (used for checking only, never stored).
  const gross = moneyCandidates(lines, P.gross).map(item => item.value);
  const total = gross.length ? Math.max(...gross) : null;
  const base = candidates.base_salary.value;
  if (base === null && total !== null) candidates.base_salary.warnings = [`מצאתי רק סה״כ ברוטו (${fmt(total)} ₪), שאינו שכר הבסיס.`];
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
      confidence: item.value !== null && !item.review && !useReversed ? 'high' : 'review', warnings: item.warnings.map(text => text.slice(0, 200)).slice(0, 4) };
  });
  const found = fields.filter(item => item.value !== null).length;
  return { fields, warnings: documentWarnings, found, looksLikePayslip: lines.some(line => P.payslip.test(line.text)) };
}
