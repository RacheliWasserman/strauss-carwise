import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { calculateNet, displayShekels, eligibility, type Calculation, type Choice } from '../calculator';
import type { Car, Employee, Group, Occupation } from '../types';
import type { CalculationRules } from '../rules-repository';
import type { EmployeeDataInput, EmployeeDataVersionRow } from '../employee-data-repository';
import type { CalculationSnapshotInput } from '../calculation-history-repository';
import type { AdvisorOccupation } from '../occupation-repository';
import type { CalculationScenario, CatalogMessage, MessageAction } from '../catalog-message';
import type { ConversationMessageRow } from '../conversation-repository';
import { awaitedRepresentativeFields, putRepresentativeEntry, representativeEntries, type AdvisorState, type FactField } from './advisor-state';
import { requestTopic, requestableFieldSchema } from '../representative-answer';
import { driveTypeIn, identifyCurrentVehicle, vehicleDirection, type VehicleIdentification } from './vehicle-identification';
import { joinNames, type CatalogRow } from './vehicle-selection';

export const CALCULATOR_VERSION = 'calculator-v1';

/* ---------- Dependencies (real repositories by default, injected in tests) ---------- */

export type VehicleLookup = Map<string, { car: Car } | { error: 'not_found' | 'tax_value_missing' }>;
export type FinancialDependencies = {
  confirmed: (userId: string) => Promise<EmployeeDataVersionRow | null>;
  versions: (userId: string) => Promise<EmployeeDataVersionRow[]>;
  createVersion: (userId: string, input: EmployeeDataInput) => Promise<EmployeeDataVersionRow>;
  confirmVersion: (userId: string, versionId: string) => Promise<EmployeeDataVersionRow | null>;
  rules: () => Promise<CalculationRules>;
  vehicles: (ids: string[]) => Promise<VehicleLookup>;
  findVehicles: (name: string) => Promise<Array<{ id: string; display_name: string }>>;
  history: (userId: string, conversationId: string) => Promise<Array<{ id: string; input_snapshot: Record<string, unknown> }>>;
  snapshot: (input: CalculationSnapshotInput) => Promise<string>;
  /** The active catalog (all rows), for identifying the employee's current car from their own words. */
  catalogRows?: () => Promise<CatalogRow[]>;
  /** The signed-in account's full name, the only source of the profile name; null when none is stored. */
  accountName?: (userId: string) => Promise<string | null>;
};

export async function defaultFinancialDependencies(): Promise<FinancialDependencies> {
  const employeeData = await import('../employee-data-repository');
  const history = await import('../calculation-history-repository');
  const vehicles = await import('../vehicle-repository');
  const { getCalculationRules } = await import('../rules-repository');
  const { searchAdvisorVehicles } = await import('../advisor-catalog-service');
  const { createSupabaseServerClient } = await import('../supabase-server');
  // Resolve each function when used, so unused repositories are never touched.
  return {
    confirmed: userId => employeeData.getLatestConfirmedEmployeeData(userId),
    versions: userId => employeeData.listEmployeeDataVersions(userId),
    createVersion: (userId, input) => employeeData.createEmployeeDataVersion(userId, input),
    confirmVersion: (userId, versionId) => employeeData.confirmEmployeeDataVersion(userId, versionId),
    rules: () => getCalculationRules(),
    async vehicles(ids) {
      const rows = await vehicles.getActiveVehicleRowsByIds(await createSupabaseServerClient(), ids);
      // Each car's official tax lookup is independent, so they run together; results keep the requested order.
      const entries = await Promise.all(ids.map(async (id): Promise<[string, { car: Car } | { error: 'not_found' | 'tax_value_missing' }]> => {
        const row = rows.find(item => item.id === id);
        if (!row) return [id, { error: 'not_found' }];
        // The official tax lookup throws unless exactly one record exists. Never substitute a value.
        try { return [id, { car: await vehicles.toCalculatorCar(row) }]; }
        catch { return [id, { error: 'tax_value_missing' }]; }
      }));
      const result: VehicleLookup = new Map(entries);
      return result;
    },
    async findVehicles(name) {
      return (await searchAdvisorVehicles({ name, limit: 10 })).vehicles;
    },
    history: (userId, conversationId) => history.listCalculationHistory(userId, conversationId),
    snapshot: input => history.createCalculationSnapshot(input),
    async catalogRows() {
      const { activeCatalog } = await import('./vehicle-selection');
      return activeCatalog(input => searchAdvisorVehicles(input));
    },
    async accountName(userId) {
      const { getOwnIdentity } = await import('../identity/identity-repository');
      const identity = await getOwnIdentity(userId);
      return identity.status === 'complete' ? `${identity.firstName} ${identity.lastName}`.trim() : null;
    }
  };
}

/* ---------- Field definitions ---------- */

type Kind = 'name' | 'money' | 'percent' | 'points' | 'count' | 'vehicle';
// `about` is the plain-language noun used inside sentences ("לא הצלחתי להבין את ...").
const FIELDS: Record<FactField, { label: string; ask: string; about: string; kind: Kind; max: number }> = {
  base_salary: { label: 'שכר בסיס חודשי ברוטו', ask: 'מה שכר הבסיס החודשי שלך ברוטו?', about: 'שכר הבסיס', kind: 'money', max: 1_000_000 },
  commissions: { label: 'עמלות חודשיות', ask: 'יש עמלות חודשיות? אם לא, אפשר לכתוב 0.', about: 'העמלות', kind: 'money', max: 1_000_000 },
  bonus: { label: 'בונוס חודשי', ask: 'ובונוס חודשי? אם אין, אפשר לכתוב 0.', about: 'הבונוס', kind: 'money', max: 1_000_000 },
  employee_pension_percent: { label: 'הפרשה לפנסיה', ask: 'כמה אחוזים מהשכר שלך מופרשים לפנסיה? (למשל 6%)', about: 'ההפרשה לפנסיה', kind: 'percent', max: 30 },
  employee_study_fund_percent: { label: 'הפרשה לקרן השתלמות', ask: 'ולקרן השתלמות, כמה אחוזים? אם אין, אפשר לכתוב 0.', about: 'ההפרשה לקרן השתלמות', kind: 'percent', max: 30 },
  tax_credit_points: { label: 'נקודות זיכוי', ask: 'כמה נקודות זיכוי יש לך? המספר מופיע בתלוש השכר.', about: 'נקודות הזיכוי', kind: 'points', max: 50 },
  current_vehicle_id: { label: 'הרכב הצמוד היום', ask: 'יש לך היום רכב צמוד מהחברה? אם כן, אפשר לכתוב את הדגם.', about: 'הרכב הנוכחי', kind: 'vehicle', max: 0 },
  current_participation: { label: 'השתתפות חודשית ברכב היום', ask: 'כמה עולה היום ההשתתפות החודשית שלך ברכב?', about: 'ההשתתפות ברכב', kind: 'money', max: 100_000 },
  eligible_children_count: { label: 'ילדים עד גיל 23', ask: 'כמה ילדים עד גיל 23 יש לך? (זה חשוב לבדיקת המסלול המשפחתי)', about: 'מספר הילדים', kind: 'count', max: 40 },
  display_name: { label: 'שם בפרופיל', ask: 'ולסיום, איך לרשום את שמך בפרופיל?', about: 'השם', kind: 'name', max: 120 }
};
/** Every field is required for a stored profile version (all NOT NULL). Asked one at a time, in this order. */
export const PROFILE_ORDER: FactField[] = ['base_salary', 'commissions', 'bonus', 'employee_pension_percent',
  'employee_study_fund_percent', 'tax_credit_points', 'current_vehicle_id', 'current_participation',
  'eligible_children_count', 'display_name'];
/** How employees refer to each field in free text. Matched as words/stems, never as whole sentences. */
const FIELD_REFERENCES: Partial<Record<FactField, RegExp>> = {
  employee_pension_percent: /פנסי/u,
  employee_study_fund_percent: /השתלמות|(?:^|[^\p{L}])[והבלמש]?קה["״'׳]?ש(?=$|[^\p{L}])/u,
  base_salary: /(?:^|[^\p{L}])[והבלמש]?(?:שכר|משכורת)(?=$|[^\p{L}])/u,
  commissions: /(?:^|[^\p{L}])[והבלמש]?(?:עמלות|עמלה)(?=$|[^\p{L}])/u,
  bonus: /בונוס/u,
  tax_credit_points: /זיכוי/u,
  current_participation: /השתתפות|משתתפ/u,
  eligible_children_count: /(?:^|[^\p{L}])[והבלמש]?(?:ילדים|ילדות|ילד)(?=$|[^\p{L}])/u
};
/**
 * The names of the fields as employees write them next to a value ("שכר 18,500", "נקודות זיכוי 2.75", "2 ילדים"), also the
 * summary's own labels. Wider than FIELD_REFERENCES (which only decides disputes); a label may carry its own number
 * ("ילדים עד גיל 23"), which is never read as the value.
 */
const FIELD_WORDS: Array<[FactField, string]> = [
  ['base_salary', 'שכר(?:\\s+ה?בסיס)?(?:\\s+(?:החודשי|חודשי|ברוטו|שלי))*|משכורת|ברוטו|מרוויח|מרוויחה|משתכר|משתכרת'],
  ['commissions', 'עמלות(?:\\s+חודשיות)?|עמלה'],
  ['bonus', 'בונוס(?:\\s+חודשי)?|בונוסים'],
  ['employee_pension_percent', 'הפרשה\\s+לפנסיה|הפרשות\\s+לפנסיה|פנסיה|פנסיוני|פנסיונית'],
  ['employee_study_fund_percent', 'הפרשה\\s+לקרן\\s+השתלמות|קרן\\s+ה?השתלמות|השתלמות|קה["״\'׳]?ש'],
  ['tax_credit_points', 'נקודות\\s+ה?זיכוי|נק["\'׳]?\\s*זיכוי|נקודות|זיכוי'],
  ['eligible_children_count', 'ילדים(?:\\s+(?:עד|מתחת\\s+ל)\\s*גיל\\s+\\d+)?|ילדות|ילד|ילדה'],
  // Also what the employee pays for today's car ("אני משלמת עליה 350 שקל בחודש", "הרכב עולה לי 350"): paying FOR the car,
  // never "משלמים לי" (being paid, a salary).
  ['current_participation', 'השתתפות(?:\\s+חודשית)?(?:\\s+ברכב(?:\\s+היום)?)?|משתתף|משתתפת|' +
    'משלמ(?:ת|ים)?\\s+(?:עליה|עליו|עליהם|על\\s+ה?רכב|על\\s+זה|בשבילו|בשבילה|לרכב|ברכב|השתתפות)|הרכב\\s+עולה\\s+לי'],
  ['display_name', 'שם\\s+בפרופיל|שמי|קוראים\\s+לי|השם\\s+שלי']
];
const FIELD_WORD_PATTERNS = FIELD_WORDS.map(([field, words]) => [field, new RegExp(`(?:^|[^\\p{L}])[והבלמש]{0,2}(${words})(?=$|[^\\p{L}])`, 'gu')] as const);
type FieldMention = { field: FactField; start: number; end: number };
function fieldMentions(text: string): FieldMention[] {
  const found: FieldMention[] = [];
  for (const [field, pattern] of FIELD_WORD_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const end = match.index! + match[0].length;
      found.push({ field, start: end - match[1].length, end });
    }
  }
  // One place names one field: the longer name wins ("נקודות זיכוי" over "נקודות"), touching names of a field merge.
  const kept = found.filter(item => !found.some(other => other !== item && other.start <= item.start && other.end >= item.end &&
    other.end - other.start > item.end - item.start)).sort((a, b) => a.start - b.start);
  return kept.filter((item, index) => !(index > 0 && kept[index - 1].field === item.field && /^\s*$/u.test(text.slice(kept[index - 1].end, item.start))));
}
/** The message names this field in the employee's own words. */
export const fieldNamedIn = (field: FactField, text: string) => fieldMentions(text).some(item => item.field === field);
/** The fields the message names, in the order written. */
export const fieldsNamedIn = (text: string) => [...new Set(fieldMentions(text).map(item => item.field))];
/**
 * Values the employee wrote next to field names, read by the server in one pass: "שכר 18,500, עמלות 0, בונוס 0,
 * פנסיה 6%, השתלמות 2.5%, נקודות זיכוי 2.75 ו־2 ילדים" gives all seven, whatever a model returned. Each clause (split
 * at commas, semicolons, line breaks and "וגם"/"אבל") pairs a name with the number directly beside it; "אין עמלות"
 * is 0. Anything not clearly paired is left out (and still asked). Questions and the current car are not read here.
 */
export function extractFieldValues(text: string): Array<{ type: 'report_fact'; field: Exclude<FactField, 'current_vehicle_id'>; value: number; evidence: string }> {
  return [...readFieldValues(text)].flatMap(([field, items]) => field === 'current_vehicle_id' || new Set(items.map(item => item.value)).size !== 1 ? [] :
    [{ type: 'report_fact' as const, field: field as Exclude<FactField, 'current_vehicle_id'>, value: items.at(-1)!.value, evidence: items.at(-1)!.evidence }]);
}
/** Fields given two different values in one message ("ההשתתפות 300 ... משלמת עליה 350"): asked, never one of them guessed. */
export function fieldValueConflicts(text: string): Array<{ field: FactField; values: number[] }> {
  return [...readFieldValues(text)].flatMap(([field, items]) => {
    const values = [...new Set(items.map(item => item.value))];
    return values.length > 1 ? [{ field, values }] : [];
  });
}
/** Words before a number that make it the value being REPLACED: "מ־21,000 ל־23,000", "במקום 3", "כבר לא 21,000 אלא…". */
const REPLACED_VALUE = /(?:(?:^|[^\p{L}])ו?מה?[־-]?\s*|(?:במקום|כבר\s+לא|ולא)\s+(?:ה[־-]?)?)$/u;
/** A value said about the future or as uncertain ("אולי השכר יעלה ל־25,000 בחודש הבא", "עדיין לא סופי"): never a fact. */
export const FUTURE_OR_UNCERTAIN = /(?:^|[^\p{L}])(?:אולי|יעלה|תעלה|ירד|תרד|יגדל|צפוי|צפויה|מתוכנן|מתוכננת|בעתיד|בחודש\s+הבא|בשנה\s+הבאה|לא\s+סופי|עדיין\s+לא)(?=$|[^\p{L}])/u;
/** The employee's numbers that are NEW values: not the value being replaced ("מ־21,000"), not part of a label. */
export function newAmountsIn(text: string): number[] {
  return amountsIn(text).filter(amount => !REPLACED_VALUE.test(text.slice(Math.max(0, amount.start - 14), amount.start))).map(amount => amount.value);
}
function readFieldValues(text: string): Map<FactField, Array<{ value: number; evidence: string }>> {
  const results = new Map<FactField, Array<{ value: number; evidence: string }>>();
  const clauses = [...text.matchAll(/[^;\n,.]+(?:[,.](?=\d)[^;\n,.]*)*/gu)];
  for (const clause of clauses) {
    for (const part of clause[0].split(/\s(?=(?:וגם|אבל|אך)\s)/u)) {
      if (part.includes('?') || FUTURE_OR_UNCERTAIN.test(part)) continue;
      const offset = clause.index! + clause[0].indexOf(part);
      const names = fieldMentions(part).filter(item => item.field !== 'display_name');
      if (!names.length) continue;
      // The label's own digits ("עד גיל 23") are part of the name, never its value; the value being replaced is not a value.
      const numbers = amountsIn(part).filter(amount => !names.some(name => amount.start >= name.start && amount.end <= name.end) &&
        !REPLACED_VALUE.test(part.slice(Math.max(0, amount.start - 14), amount.start)));
      const items = [...names.map(name => ({ kind: 'name' as const, ...name })), ...numbers.map(amount => ({ kind: 'number' as const, ...amount }))]
        .sort((a, b) => a.start - b.start);
      const used = new Set<number>();
      // "שכר 18,500" (name first) or "2 ילדים" (number first): the clause's first item says which side a number is on.
      const nameFirst = items[0].kind === 'name';
      for (const name of names) {
        const at = items.findIndex(item => item.kind === 'name' && item.start === name.start);
        const near = (step: number) => {
          const item = items[at + step];
          const between = item && (step > 0 ? part.slice(name.end, item.start) : part.slice(item.end, name.start));
          return item?.kind === 'number' && !used.has(item.start) && between!.length <= 24 && !/[A-Za-z]/.test(between!) ? item : undefined;
        };
        const number = nameFirst ? near(1) ?? near(-1) : near(-1) ?? near(1);
        let value: number | undefined;
        let from = name.start, to = name.end;
        if (number) { used.add(number.start); value = number.value; from = Math.min(from, number.start); to = Math.max(to, number.end); }
        else if (name.field !== 'base_salary') {
          // "אין עמלות", "בלי בונוס", "ללא ילדים": zero, said in words next to the name.
          const before = part.slice(Math.max(0, name.start - 14), name.start);
          const said = /(?:^|[^\p{L}])ו?((?:אין(?:\s+לי)?|בלי|ללא|לא\s+מקבל(?:ת)?)\s*)$/u.exec(before);
          // The evidence starts at the word itself ("אין לי עמלות", not "ואין"), as the zero check reads it.
          if (said) { value = 0; from = name.start - said[1].length; }
        }
        if (value === undefined) continue;
        results.set(name.field, [...(results.get(name.field) ?? []), { value, evidence: text.slice(offset + from, offset + to).trim() }]);
      }
    }
  }
  return results;
}
const DISPUTE_MARKER =/(?:^|[^\p{L}])(?:לא\s+(?:נכון|נכונה|נכונים|נכונות|מדויק|מדויקת|מדויקים|מדויקות|מעודכן|מעודכנת|מעודכנים)|שגוי|שגויה|שגויים|שגויות|טעות|טעויות|טעיתי|טעית|טעיתם|לתקן|לשנות|לעדכן|תיקון)(?=$|[^\p{L}])/u;
export const GENERAL_CORRECTION_QUESTION = 'בשמחה, אילו פרטים לתקן? אפשר לכתוב כמה פרטים יחד. אם הערך הנכון של פרט מסוים לא ידוע, אפשר פשוט לכתוב את זה.';
/**
 * "אבל חלק מהנתונים לא נכונים": a correction of the financial details without naming one. Messages that name a
 * field, give an amount, or talk about cars/models are not this (they have their own, more specific handling).
 */
export function generalCorrectionIntent(text: string) {
  return DISPUTE_MARKER.test(text) && !numbersIn(text).length && !disputedFieldsIn(text, true).length &&
    !/[A-Za-z]{2,}|(?:^|[^\p{L}])[והבלמש]?(?:רכב|רכבים|דגם|חשמלי|היברידי|בנזין|משפחתי)(?=$|[^\p{L}])/u.test(text);
}
/** Which of the named fields the employee says they do not know, judged per clause ("…לא יודעת כמה הפנסיה, וגם הזיכוי לא נכון"). */
export function unknownFieldsIn(text: string, fields: FactField[]): FactField[] {
  const clauses = text.split(/[,.;!?]|\s(?:וגם|אבל|אך)\s/u).map(clause => ({
    named: fields.filter(field => FIELD_REFERENCES[field]?.test(clause)), unknown: saysUnknown(clause) }));
  const unknown = new Set<FactField>();
  clauses.forEach((clause, index) => {
    if (!clause.unknown) return;
    // "…לא נכון אבל אני לא יודעת כמה": a clause naming no field refers to the nearest field clause before it (else after it).
    const target = clause.named.length ? clause : clauses.slice(0, index).reverse().find(item => item.named.length)
      ?? clauses.slice(index + 1).find(item => item.named.length);
    (target?.named ?? fields).forEach(field => unknown.add(field));
  });
  return fields.filter(field => unknown.has(field));
}
export const saysUnknown = (text: string) => /(?:^|[^\p{L}])לא\s+(?:יודע|יודעת|זוכר|זוכרת|בטוח|בטוחה)(?=$|[^\p{L}])/u.test(text);
/**
 * Fields the employee says are wrong ("הפרשות לפנסיה לא נכון"). Right after "which detail?" naming the field is
 * enough; elsewhere an explicit marker (לא נכון, טעות, לתקן…) is required.
 */
export function disputedFieldsIn(text: string, answeringWhichDetail: boolean): FactField[] {
  // "I don't know my X" about a known value is a dispute too: the confirmed value is not trusted for this calculation.
  if (!answeringWhichDetail && !DISPUTE_MARKER.test(text) && !saysUnknown(text)) return [];
  return (Object.keys(FIELD_REFERENCES) as FactField[]).filter(field => FIELD_REFERENCES[field]!.test(text));
}

/** The wording of the single question for a field, so another reply can show the question still on screen. */
export const questionFor = (field: FactField) => FIELDS[field].ask;
/** The next single question. A dependent field waits for the field it depends on. */
export function nextQuestion(missing: FactField[], unknown: FactField[] = []): FactField | undefined {
  return missing.find(field => !unknown.includes(field) &&
    !(field === 'current_participation' && missing.includes('current_vehicle_id')));
}
const ACKS = ['מעולה!', 'מצוין.', 'תודה!', 'קיבלתי.'];
/** A request names the one missing field when a representative can answer it; otherwise a general topic. */
const topicFor = (field?: FactField) => {
  const requestable = requestableFieldSchema.safeParse(field);
  if (requestable.success) return requestTopic(requestable.data);
  // The current car has its own topic, so the request stays linked to that field (not asked again while open).
  return field === 'current_vehicle_id' ? CURRENT_VEHICLE_TOPIC : 'השלמת פרטי שכר לחישוב נטו';
};

/* ---------- Fact validation against the employee's own words ---------- */

const WORDS: Record<string, number> = { אפס: 0, אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלוש: 3, שלושה: 3,
  ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10 };

/** Numbers literally present in text: 18,000 / 18000 / 18 אלף / 2.25 / 2,75 / 2 וחצי / שלושה. */
export function numbersIn(text: string): number[] {
  return amountsIn(text).map(amount => amount.value);
}
type Amount = { value: number; start: number; end: number };
/** The numbers of numbersIn() with their place in the text (digits first, then number words). */
function amountsIn(text: string): Amount[] {
  const found: Amount[] = [];
  // Catalog IDs and model numbers are identifiers, not amounts. Keep amounts elsewhere in the sentence (blanked in
  // place, so positions stay).
  text = text.replace(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[-־ ]+\d+(?:\.\d+)?|\d+)(?![A-Za-z0-9])/gu, match => ' '.repeat(match.length));
  // Digits glued to Latin letters are model names ("MG4", "EV3", "ATTO3"), never amounts. A comma before three digits
  // groups thousands ("18,500"); before one or two digits it is a decimal comma ("2,75" נקודות זיכוי).
  for (const match of text.matchAll(/(?<![A-Za-z\d.,])(\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.(\d+)|,(\d{1,2})(?![\d,]))?(\s*(?:אלף|k|K)(?![\p{L}]))?(\s*וחצי)?/gu)) {
    if (!match[4] && /^[A-Za-z]/.test(text.slice(match.index! + match[0].length))) continue;
    const decimals = match[2] ?? match[3];
    let value = Number(match[1].replace(/,/g, '') + (decimals ? '.' + decimals : ''));
    if (match[5]) value += 0.5;
    if (match[4]) value *= 1000;
    found.push({ value, start: match.index!, end: match.index! + match[0].length });
  }
  for (const match of text.matchAll(/(?:^|[^\p{L}])[וה]?(\p{L}+)(\s+וחצי)?(?=$|[^\p{L}])/gu)) {
    const value = WORDS[match[1]];
    const end = match.index! + match[0].length;
    if (value !== undefined) found.push({ value: value + (match[2] ? 0.5 : 0), start: end - (match[2]?.length ?? 0) - match[1].length, end });
  }
  return found;
}
const negation = (text: string) => /(?:^|[^\p{L}])(?:אין|לא|ללא|בלי|אפס)(?=$|[^\p{L}])/u.test(text);
const moneyWords = /₪|ש["״']?ח|שקל|שקלים/u;
const percentWords = /%|אחוז/u;

export type FactCheck = { ok: true; value: string | number } | { ok: false; note: string };
export function checkFact(field: FactField, value: string | number, evidence: string): FactCheck {
  const spec = FIELDS[field];
  if (spec.kind === 'vehicle') return { ok: false, note: 'את הרכב הנוכחי אני מזהה רק מתוך קטלוג החברה.' };
  if (spec.kind === 'name') {
    const raw = String(value).trim();
    // A name copied from a pasted summary must not keep the table's source label ("רחל פרידמן מאושר").
    const name = evidence.includes(FIELDS.display_name.label) ? withoutSourceLabel(raw) : raw;
    return name && name.length <= spec.max && evidence.includes(name) ? { ok: true, value: name } : { ok: false, note: 'לא הצלחתי להבין את השם.' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, note: `לא הצלחתי להבין את ${spec.about}.` };
  const supported = numbersIn(evidence).some(number => Math.abs(number - value) < 1e-9) || (value === 0 && negation(evidence));
  if (!supported) return { ok: false, note: `לא הצלחתי להבין את ${spec.about}. אפשר לכתוב במספרים?` };
  if (spec.kind === 'percent' && (value > spec.max || (moneyWords.test(evidence) && !percentWords.test(evidence)))) {
    return { ok: false, note: `ל${spec.about} צריך אחוז מהשכר ולא סכום בשקלים. האחוז מופיע בתלוש.` };
  }
  if (spec.kind === 'money' && percentWords.test(evidence) && !moneyWords.test(evidence)) {
    return { ok: false, note: `ל${spec.about} צריך סכום חודשי בשקלים ולא אחוז.` };
  }
  if (spec.kind === 'count' && !Number.isInteger(value)) return { ok: false, note: `${spec.about} צריך להיות מספר שלם.` };
  if (value > spec.max) return { ok: false, note: `נראה שיש טעות ב${spec.about}. אפשר לבדוק שוב?` };
  if (field === 'base_salary' && value < 1000) {
    return { ok: false, note: `רק לוודא, התכוונת ל־${(value * 1000).toLocaleString('he-IL')} ₪ בחודש?` };
  }
  return { ok: true, value };
}

export type FinancialOperation =
  | { type: 'report_fact'; field: FactField; value: string | number; evidence: string }
  | { type: 'unknown_fact'; field: FactField; evidence: string }
  | { type: 'report_current_vehicle'; hasCar: boolean; name?: string; evidence: string };

/**
 * A value enters the conversation as pending. When the EMPLOYEE supplies the very field an open representative request
 * is about, that request is superseded: the employee's newer value stands, and a late answer will not replace it.
 */
function putFact(state: AdvisorState, field: FactField, value: string | number, sourceMessageId: string, byEmployee = true) {
  state.pendingFacts = state.pendingFacts.filter(fact => fact.field !== field);
  state.pendingFacts.push({ field, value, sourceMessageId, status: 'pending_confirmation' });
  state.unknownFacts = (state.unknownFacts ?? []).filter(item => item !== field);
  if (!byEmployee) return;
  const representative = state.representative;
  if (representative?.status === 'requested' && representative.field === field) state.representative = { ...representative, status: 'superseded' };
  // Every request still waiting for this field (several requests may be open in one conversation).
  for (const entry of representativeEntries(state)) {
    if (entry.status === 'requested' && entry.field === field) putRepresentativeEntry(state, { ...entry, status: 'superseded' });
  }
}
/** The representative topic used when the current car cannot be identified; it is about current_vehicle_id. */
export const CURRENT_VEHICLE_TOPIC = 'בדיקת הרכב הנוכחי';
const YES_ONLY = /^(?:כן|יש|יש לי|יש לי רכב|נכון|בטח)[\s!.,]*$/u;
/** Wording about the car one drives today (not a car one wants). */
const OWN_CAR = /(?:^|[^\p{L}])(?:יש לי|הרכב שלי|הרכב הצמוד|הרכב הנוכחי|אני נוהג|אני נוהגת|נוסע עם|נוסעת עם)(?=$|[^\p{L}])/u;

/**
 * The current car from the employee's own words, against the active catalog (see vehicle-identification.ts).
 * A model's suggested name is only a fallback. One match is accepted; a manufacturer or several models get ONE
 * targeted choice; nothing found asks for the model name, and only a repeated failure offers a representative.
 */
/** What the conversation already knows about the current car, for reading the employee's words about it. */
export type VehicleContext = {
  /** The car of the approved profile (read only when the words leave a choice). */
  approvedVehicleId?: () => Promise<string | null>;
  /** The catalog cars offered as buttons in the previous reply ("איזה מהם הרכב הצמוד שלך היום?"). */
  previousChoices?: string[];
};
async function currentVehicleFrom(state: AdvisorState, text: string, modelName: string | undefined, latest: ConversationMessageRow,
  deps: Pick<FinancialDependencies, 'findVehicles' | 'catalogRows'>, result: AppliedFacts, quiet = false, context: VehicleContext = {}): Promise<void> {
  const note = (value: string) => result.notes.push({ field: 'current_vehicle_id', text: value, explicit: true });
  let rows: CatalogRow[];
  try {
    rows = deps.catalogRows ? await deps.catalogRows()
      : modelName ? (await deps.findVehicles(modelName)).map(row => ({ manufacturer_name: '', group_code: 'א' as const, drive_type: '', ...row })) : [];
  } catch { note('לא הצלחתי לבדוק את הרכב שלך בקטלוג כרגע. אפשר לנסות שוב עוד רגע.'); return; }
  // "לעבור מ-COROLLA CROSS ל-BYD ATTO 3": the car after "מ-" is today's car; the car the employee wants is never taken
  // as today's car (also not through its brand word, "BYD").
  const direction = vehicleDirection(text, rows);
  const wanted = new Set(direction.to.map(item => item.row.id));
  let found: VehicleIdentification = direction.from.length === 1 ? { kind: 'match', row: direction.from[0].row } : identifyCurrentVehicle(text, modelName, rows);
  if (found.kind === 'match' && wanted.has(found.row.id)) found = { kind: 'none' };
  if (found.kind === 'choose') {
    const choices = found.rows.filter(row => !wanted.has(row.id));
    found = choices.length === 1 ? { kind: 'match', row: choices[0] } : choices.length ? { ...found, rows: choices } : { kind: 'none' };
  }
  // Several cars written and one of them is the approved car: that is the car, not a question.
  if (found.kind === 'choose' && context.approvedVehicleId) {
    let approved: string | null = null;
    try { approved = await context.approvedVehicleId(); } catch { /* Asked as usual. */ }
    const row = found.rows.find(item => item.id === approved);
    if (row) found = { kind: 'match', row };
  }
  // A drive type as the answer ("היברידי" to "COROLLA או COROLLA CROSS?"): the offered car of that type, or a choice
  // among the catalog cars of that type. Never a catalog search.
  const drive = found.kind === 'none' ? driveTypeIn(text) : undefined;
  if (drive && text.trim().length <= 40) {
    const offered = rows.filter(row => context.previousChoices?.includes(row.id) && row.drive_type === drive);
    const ofType = offered.length ? offered : rows.filter(row => row.drive_type === drive);
    if (ofType.length === 1) found = { kind: 'match', row: ofType[0] };
    else if (ofType.length) {
      found = { kind: 'choose', rows: ofType.slice(0, 6), basis: 'name' };
      if (!quiet && (state.pendingFieldAsks ?? 1) < 2) {
        result.vehicleChoices = found.rows;
        const names = found.rows.map(row => row.display_name);
        note(`איזה רכב ${drive} הוא הרכב הצמוד שלך היום: ${names.length > 1 ? `${names.slice(0, -1).join(', ')} או ${names.at(-1)}` : names[0]}?`);
        return;
      }
    }
  }
  if (found.kind === 'match') { putFact(state, 'current_vehicle_id', found.row.id, latest.id); result.accepted++; return; }
  // While a representative checks the car, only a clearly named model counts; anything else is not about the car.
  if (quiet) return;
  // The message is about the car the employee wants ("אני רוצה ATTO 3"), not today's car: nothing to ask about it.
  if (found.kind === 'none' && direction.to.length && !direction.from.length) return;
  if (found.kind === 'choose') {
    result.vehicleChoices = found.rows;
    const names = found.rows.map(row => row.display_name);
    // Asked already: a shorter follow-up that points to the buttons, not the same sentence again.
    if ((state.pendingFieldAsks ?? 1) >= 2 && names.length > 1) { note(`רק לוודא, איזה מהם: ${names.join(' או ')}? אפשר ללחוץ על אחד הכפתורים, או לכתוב את שם הדגם.`); return; }
    note(found.basis === 'manufacturer'
      ? names.length === 1 ? `ל${found.manufacturer} יש בקטלוג החברה דגם אחד: ${names[0]}. זה הרכב הצמוד שלך היום?`
        : `ל${found.manufacturer} יש בקטלוג החברה ${names.length} דגמים: ${joinNames(names)}. איזה מהם הרכב הצמוד שלך היום?`
      : `איזה מהם הרכב הצמוד שלך היום: ${names.join(' או ')}?`);
    return;
  }
  if (YES_ONLY.test(text.trim())) { note('מעולה. איזה דגם הרכב הצמוד שלך היום?'); return; }
  const written = text.trim().replace(/\s+/g, ' ').slice(0, 40);
  note(`לא מצאתי בקטלוג החברה דגם שמתאים ל"${written}". אפשר לכתוב את שם הדגם כפי שהוא מופיע ברישיון הרכב (למשל TUCSON או COROLLA), או "אין" אם אין רכב צמוד.`);
  // A representative only after the model name could not be identified more than once.
  if ((state.pendingFieldAsks ?? 1) >= 2) result.offerRepresentative = CURRENT_VEHICLE_TOPIC;
}

/** Apply validated employee facts to conversation state only. Never writes a profile. Returns clarifications. */
/** A clarification about one field. explicit: the employee actually wrote a value (a number, "אין", a car name). */
export type FinancialNote = { field?: FactField; text: string; explicit: boolean };
export type AppliedFacts = { notes: FinancialNote[]; accepted: number; unknownNow: FactField[]; offerRepresentative?: string;
  /** Catalog cars to choose from for the current car (shown as buttons). */
  vehicleChoices?: CatalogRow[];
  /** Model values dropped because the message names neither their field nor answers the question on screen. */
  unanchored?: number };
const explicitValue = (evidence: string) => numbersIn(evidence).length > 0 || negation(evidence);
// "מה יקרה אם אוותר על רכב?" describes a possible future, never the car situation today.
export const hypothetical = (text: string) => /(?:^|[^\p{L}])ו?(?:אם|מה יקרה|מה יהיה|במקרה ש)(?=$|[^\p{L}])/u.test(text);
const CURRENT_CAR_FIELDS: FactField[] = ['current_vehicle_id', 'current_participation'];

/**
 * A short direct answer to the single question on screen ("18 אלף", "אין", "לא יודעת") is understood by the
 * server even when the model returned no operation. It goes through the same evidence and range checks.
 */
async function answerPendingField(state: AdvisorState, latest: ConversationMessageRow, result: AppliedFacts,
  deps: Pick<FinancialDependencies, 'findVehicles' | 'catalogRows'>, context: VehicleContext = {}) {
  const field = state.pendingField;
  const body = latest.body.trim();
  // The current car may be written as a phrase ("כן, יונדאי טוסון מצ'כיה"); other answers are short values.
  if (!field || body.length > (field === 'current_vehicle_id' ? 120 : 40) || body.includes('?')) return;
  if (/(?:^|[^\p{L}])לא\s+(?:יודע|יודעת|זוכר|זוכרת|בטוח|בטוחה)(?=$|[^\p{L}])/u.test(body)) {
    state.pendingFacts = state.pendingFacts.filter(fact => fact.field !== field);
    state.unknownFacts = [...new Set([...(state.unknownFacts ?? []), field])];
    result.unknownNow.push(field);
    return;
  }
  const kind = FIELDS[field].kind;
  if (kind === 'name') return;
  if (kind === 'vehicle') {
    const awaiting = awaitedRepresentativeFields(state).includes('current_vehicle_id');
    if (!awaiting && negation(body) && !numbersIn(body).length && !/[A-Za-z]/.test(body)) { putFact(state, field, 'NONE', latest.id); result.accepted++; return; }
    await currentVehicleFrom(state, body, undefined, latest, deps, result, awaiting, context);
    return;
  }
  const numbers = [...new Set(numbersIn(body))];
  const value = numbers.length === 1 ? numbers[0] : numbers.length === 0 && negation(body) && field !== 'base_salary' ? 0 : undefined;
  if (value === undefined) return;
  const checked = checkFact(field, value, body);
  if (checked.ok) { putFact(state, field, checked.value, latest.id); result.accepted++; } else result.notes.push({ field, text: checked.note, explicit: true });
}

export type ApplyOptions = VehicleContext & {
  /** Read values written next to field names in the employee's own words (not for what-ifs, codes or forms). */
  extract?: boolean;
  /** The message asks for a representative: it is not an answer to the question on screen. */
  notAnAnswer?: boolean;
  /** Today's car is named in the employee's own words as the car moved from: a present fact, also inside a what-if. */
  presentCar?: boolean;
};
export async function applyFinancialOperations(state: AdvisorState, operations: FinancialOperation[], latest: ConversationMessageRow,
  deps: Pick<FinancialDependencies, 'findVehicles' | 'catalogRows'>, options: ApplyOptions = {}): Promise<AppliedFacts> {
  const result: AppliedFacts = { notes: [], accepted: 0, unknownNow: [] };
  const notes = result.notes;
  // Values written next to field names are read by the server ("שכר 18,500, ... נקודות זיכוי 2.75 ו־2 ילדים"): all of them,
  // and they replace a model's reading of those fields (a model may skip some, or take "2" from "2 ילדים" as the points).
  const extracted = options.extract ? extractFieldValues(latest.body) : [];
  // Two different values for one field in the same message: neither is used (nor a model's), the employee is asked.
  const conflicts = options.extract ? fieldValueConflicts(latest.body) : [];
  const extractedFields = new Set<FactField>([...extracted.map(operation => operation.field), ...conflicts.map(item => item.field)]);
  for (const { field, values } of conflicts) {
    const shown = values.map(value => FIELDS[field].kind === 'money' ? `${value.toLocaleString('he-IL')} ₪` : FIELDS[field].kind === 'percent' ? `${value}%` : value.toLocaleString('he-IL'));
    // ("ל" absorbs the article: "להשתתפות ברכב", not "לההשתתפות".)
    notes.push({ field, text: `כתבת שני ערכים שונים ל${FIELDS[field].about.replace(/^ה/u, '')}: ${joinNames(shown)}. מה הערך הנכון?`, explicit: true });
  }
  // A model value counts only for a field the message names, or as the answer to the question on screen: a bare "0"
  // under the summary is not permission to change some field.
  let unanchored = 0;
  // The clause a quote sits in ("אולי השכר יעלה ל־25,000 בחודש הבא"): a future or uncertain value is never a fact,
  // whoever read it.
  const clauseOf = (quote: string) => {
    const at = latest.body.indexOf(quote);
    if (at < 0) return quote;
    const start = Math.max(...[',', '.', ';', '\n', '?', '!'].map(mark => latest.body.lastIndexOf(mark, at - 1))) + 1;
    const ends = [',', '.', ';', '\n', '?', '!'].map(mark => latest.body.indexOf(mark, at + quote.length)).filter(index => index >= 0);
    return latest.body.slice(start, ends.length ? Math.min(...ends) : latest.body.length);
  };
  operations = [...operations.filter(operation => {
    if (operation.type !== 'report_fact' && operation.type !== 'unknown_fact') return true;
    if (extractedFields.has(operation.field)) return false;
    if (operation.type === 'report_fact' && FUTURE_OR_UNCERTAIN.test(clauseOf(operation.evidence))) return false;
    if ((operation.field === state.pendingField && !options.notAnAnswer) || fieldNamedIn(operation.field, latest.body)) return true;
    unanchored++;
    return false;
  }), ...extracted].map((operation, index) => ({ operation, index,
    at: ('field' in operation ? fieldMentions(latest.body).find(item => item.field === operation.field)?.start : undefined) ?? latest.body.indexOf(operation.evidence) }))
    // In the order written, as the employee said them.
    .sort((a, b) => (a.at < 0 || b.at < 0 ? 0 : a.at - b.at) || a.index - b.index).map(item => item.operation);
  if (unanchored) { result.unanchored = unanchored; console.info('[carwise.ai.financial]', { droppedUnanchoredValues: unanchored }); }
  // While a representative checks the current car, the employee may still name it in any later message ("בעצם יש לי TUCSON").
  const carAwaited = awaitedRepresentativeFields(state).includes('current_vehicle_id') &&
    state.pendingField !== 'current_vehicle_id' && !state.pendingFacts.some(fact => fact.field === 'current_vehicle_id') &&
    !operations.some(operation => operation.type === 'report_current_vehicle');
  if (carAwaited && OWN_CAR.test(latest.body)) await currentVehicleFrom(state, latest.body, undefined, latest, deps, result, true, options);
  // The model reported nothing usable for the question on screen: the server reads the answer itself.
  const answersPending = operations.some(operation => 'field' in operation ? operation.field === state.pendingField : true);
  if (!options.notAnAnswer && (!operations.length || !answersPending && state.pendingField === 'current_vehicle_id')) {
    await answerPendingField(state, latest, result, deps, options);
    if (!operations.length) return result;
  }
  if (!operations.length) return result;
  const future = hypothetical(latest.body);
  for (const operation of operations) {
    if (!latest.body.includes(operation.evidence)) continue;
    // A hypothetical question never changes the current car or participation in the profile ("אם אוותר על הרכב").
    // Only the car moved FROM in the employee's words ("אם אעבור מהקורולה קרוס ל...") is today's car, a present fact.
    if (future && ((operation.type === 'report_current_vehicle' && !options.presentCar) ||
      (operation.type === 'report_fact' && CURRENT_CAR_FIELDS.includes(operation.field)))) continue;
    if (operation.type === 'report_fact') {
      // Evidence may be only the digits sliced out of an ID ("03" from CAR-03).
      // Require the value to occur as an amount in the full employee message as well.
      if (typeof operation.value === 'number' && !numbersIn(latest.body).includes(operation.value) &&
        !(operation.value === 0 && negation(latest.body))) continue;
      const checked = checkFact(operation.field, operation.value, operation.evidence);
      if (checked.ok) { putFact(state, operation.field, checked.value, latest.id); result.accepted++; }
      else notes.push({ field: operation.field, text: checked.note, explicit: explicitValue(operation.evidence) });
    } else if (operation.type === 'unknown_fact') {
      state.pendingFacts = state.pendingFacts.filter(fact => fact.field !== operation.field);
      state.unknownFacts = [...new Set([...(state.unknownFacts ?? []), operation.field])];
      result.unknownNow.push(operation.field);
    } else if (!operation.hasCar) {
      putFact(state, 'current_vehicle_id', 'NONE', latest.id);
      result.accepted++;
    } else {
      // The employee's words decide; the model's name (possibly a catalog spelling of Hebrew text, or a guess such as
      // "HYUNDAI TUCSON" for "יונדאי צ'כיה") is used only when the words name nothing in the catalog.
      await currentVehicleFrom(state, latest.body, operation.name, latest, deps, result, false, options);
    }
  }
  return result;
}

/**
 * Puts a representative's answer into the conversation as a pending value, after the caller verified the
 * request and the sender. The value passes the same range checks as the employee's own answers and still
 * needs the employee's approval in the summary before it is saved or used.
 */
export function applyRepresentativeValue(state: AdvisorState, field: FactField, value: number, sourceMessageId: string): string | null {
  return applyReviewedValue(state, field, value, sourceMessageId, 'representative');
}

/**
 * A value the employee reviewed outside free text (a representative's answer, or a payslip review form). Same range
 * and unit checks as a typed value; it stays a pending value until the summary is approved.
 */
export function applyReviewedValue(state: AdvisorState, field: FactField, value: number, sourceMessageId: string,
  source?: 'representative' | 'payslip' | 'corrected'): string | null {
  const unit = FIELDS[field].kind === 'percent' ? '%' : FIELDS[field].kind === 'money' ? ' ₪' : '';
  const checked = checkFact(field, value, `${value}${unit}`);
  if (!checked.ok) return checked.note;
  putFact(state, field, checked.value, sourceMessageId, source !== 'representative');
  const fact = state.pendingFacts.find(item => item.field === field);
  if (fact && source) fact.source = source;
  return null;
}
/** A field the employee marked as unknown in a review form: never a value, and offered to a representative. */
export function markFieldUnknown(state: AdvisorState, field: FactField) {
  state.pendingFacts = state.pendingFacts.filter(fact => fact.field !== field);
  state.unknownFacts = [...new Set([...(state.unknownFacts ?? []), field])];
}

/* ---------- Proposed profile ---------- */

type Values = Partial<Omit<EmployeeDataInput, 'current_vehicle_id'>> & { current_vehicle_id?: string | null };
type Status = 'confirmed' | 'new' | 'changed' | 'derived' | 'representative' | 'payslip' | 'corrected' | 'account';
export type Proposal = { values: Values; status: Partial<Record<keyof EmployeeDataInput, Status>>; changed: boolean; missing: Array<FactField | 'occupation_title'> };
const numeric = ['base_salary', 'commissions', 'bonus', 'employee_pension_percent', 'employee_study_fund_percent',
  'tax_credit_points', 'eligible_children_count', 'current_participation'] as const;

export function buildProposal(confirmed: EmployeeDataVersionRow | null, state: AdvisorState, occupation?: AdvisorOccupation, accountName?: string | null): Proposal {
  const values: Values = {};
  const status: Proposal['status'] = {};
  if (confirmed) {
    values.display_name = confirmed.display_name; values.occupation_title = confirmed.occupation_title;
    for (const key of numeric) values[key] = Number(confirmed[key]);
    values.current_vehicle_id = confirmed.current_vehicle_id;
    for (const key of Object.keys(values) as Array<keyof Values>) status[key] = 'confirmed';
  }
  const set = (key: keyof EmployeeDataInput, value: string | number | null) => {
    const same = confirmed && (numeric as readonly string[]).includes(key) ? Number(confirmed[key]) === value : confirmed?.[key] === value;
    values[key as keyof Values] = value as never;
    status[key] = same ? 'confirmed' : confirmed ? 'changed' : 'new';
  };
  if (occupation) set('occupation_title', occupation.title);
  for (const fact of state.pendingFacts) {
    set(fact.field, fact.field === 'current_vehicle_id' && fact.value === 'NONE' ? null : fact.value);
    // The summary says where a new value came from: a representative, the payslip, or the employee's correction of it.
    if (fact.source && status[fact.field] !== 'confirmed') status[fact.field] = fact.source;
  }
  // Participation belongs to the current car. A changed car without a new participation must be asked again.
  const carChanged = status.current_vehicle_id === 'new' || status.current_vehicle_id === 'changed';
  const participationReported = state.pendingFacts.some(fact => fact.field === 'current_participation');
  if (values.current_vehicle_id === null && !participationReported) { values.current_participation = 0; status.current_participation = confirmed && Number(confirmed.current_participation) === 0 ? 'confirmed' : 'derived'; }
  else if (carChanged && !participationReported) { delete values.current_participation; delete status.current_participation; }
  // A value the employee disputed in this conversation is not reused, even though it stays in the saved history.
  if (confirmed) for (const field of state.disputedFacts ?? []) {
    const replacement = state.pendingFacts.find(fact => fact.field === field);
    if (!replacement) { delete values[field as keyof Values]; delete status[field as keyof EmployeeDataInput]; }
    else if (status[field as keyof EmployeeDataInput] === 'confirmed') status[field as keyof EmployeeDataInput] = 'changed';
  }
  // The signed-in account's name is the profile name: never asked, and never taken from chat text, a payslip or
  // a representative. On its own, a different name does not require a new version (the calculator does not use it).
  if (accountName) {
    values.display_name = accountName;
    status.display_name = confirmed?.display_name === accountName ? 'confirmed' : 'account';
  }
  const missing: Proposal['missing'] = [];
  if (!values.occupation_title) missing.push('occupation_title');
  for (const field of PROFILE_ORDER) {
    if (field === 'current_vehicle_id' ? values.current_vehicle_id === undefined : values[field] === undefined) missing.push(field);
  }
  const changed = !confirmed || Object.entries(status).some(([key, item]) => item !== 'confirmed' && !(key === 'display_name' && item === 'account'));
  // Nothing else changed: keep the approved version exactly as it is (its stored name included).
  if (!changed && confirmed) values.display_name = confirmed.display_name;
  return { values, status, changed, missing };
}

const canonical = (values: Values) => JSON.stringify(['display_name', 'occupation_title', ...numeric, 'current_vehicle_id']
  .map(key => [key, values[key as keyof Values] ?? null]));
/** Binds an approval to the exact values AND the confirmed version they were based on. */
export function proposalCode(values: Values, basedOnVersionId: string | null, disputed: FactField[] = []) {
  return createHash('sha256').update(canonical(values) + '|' + (basedOnVersionId ?? 'none') + '|' + [...disputed].sort().join(','))
    .digest('hex').slice(0, 8).toUpperCase();
}
function sameProfile(row: EmployeeDataVersionRow, values: Values) {
  return row.display_name === values.display_name && row.occupation_title === values.occupation_title &&
    (row.current_vehicle_id ?? null) === (values.current_vehicle_id ?? null) && numeric.every(key => Number(row[key]) === values[key]);
}
function toInput(values: Values): EmployeeDataInput {
  // Every value is explicit here; schema defaults never fill a missing field.
  return { display_name: values.display_name!, occupation_title: values.occupation_title!, base_salary: values.base_salary!,
    commissions: values.commissions!, bonus: values.bonus!, employee_pension_percent: values.employee_pension_percent!,
    employee_study_fund_percent: values.employee_study_fund_percent!, tax_credit_points: values.tax_credit_points!,
    eligible_children_count: values.eligible_children_count!, current_vehicle_id: values.current_vehicle_id ?? null,
    current_participation: values.current_participation! };
}

/* ---------- Calculator adapters (authenticated profile → existing calculator types) ---------- */

export function toCalculatorOccupation(row: AdvisorOccupation): Occupation {
  return { 'עיסוק': row.title, 'קבוצת זכאות': row.group_code, 'רכב חובה': row.car_mandatory ? 'כן' : 'לא',
    'מותר לוותר': row.waiver_allowed ? 'כן' : 'לא', 'אחזקת רכב בוויתור (₪)': row.waiver_maintenance_amount };
}
export function toCalculatorEmployee(profile: EmployeeDataVersionRow, occupation: AdvisorOccupation): Employee {
  const number = (value: unknown) => z.number().finite().nonnegative().parse(Number(value));
  return { 'מזהה': profile.id, 'שם': profile.display_name, 'ת״ז (פיקטיבית)': '', 'עיסוק': occupation.title,
    'קבוצה': occupation.group_code as Group, 'שכר בסיס': number(profile.base_salary), 'עמלות': number(profile.commissions),
    'בונוס': number(profile.bonus), 'פנסיה עובד %': number(profile.employee_pension_percent),
    'קרן השתלמות עובד %': number(profile.employee_study_fund_percent), 'נקודות זיכוי': number(profile.tax_credit_points),
    'ילדים עד 23': number(profile.eligible_children_count), currentVehicleId: profile.current_vehicle_id,
    'השתתפות היום': number(profile.current_participation), 'השאלה': '' };
}

/* ---------- Presentation helpers ---------- */

/**
 * The approval summary's "source" column ("מאושר", "עודכן"…) follows every value when the table is copied and
 * pasted back. Only a trailing source label is removed, and only from a pasted summary; legitimate names stay intact.
 */
// Includes labels of earlier versions, which may still be pasted back from older summaries.
const SOURCE_LABELS = ['מאושר', 'חדש', 'עודכן', 'נגזר', 'מנציג', 'מתלוש', 'תוקן ידנית', 'תוקן על ידי העובדת', 'מהחשבון'];
export function withoutSourceLabel(value: string) {
  let result = value.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const label of SOURCE_LABELS) if (result.endsWith(` ${label}`)) { result = result.slice(0, -label.length - 1).trim(); changed = true; }
  }
  return SOURCE_LABELS.includes(result) ? '' : result;
}

/** Text of the summary's "fix a detail" button; recognised by the server as a request, not as data. */
export const CORRECTION_REQUEST = 'אני רוצה לתקן פרט בסיכום';

/**
 * Values written next to the approval summary's own labels ("שכר בסיס חודשי ברוטו 21,000 ₪ עמלות חודשיות 0 ₪ …").
 * This parses the server's own form, not free language: each value is the text between its label and the next
 * label, and still passes the same evidence/range checks. Unparseable segments are simply left to the model.
 */
export function labeledCorrections(text: string) {
  const labels = (Object.keys(FIELDS) as FactField[]).map(field => ({ field, label: FIELDS[field].label }));
  const found = labels.flatMap(({ field, label }) => { const index = text.indexOf(label); return index < 0 ? [] : [{ field, label, index }]; })
    .sort((a, b) => a.index - b.index);
  const operations: Array<{ type: 'report_fact'; field: Exclude<FactField, 'current_vehicle_id'>; value: string | number; evidence: string }
    | { type: 'report_current_vehicle'; hasCar: boolean; name?: string; evidence: string }> = [];
  found.forEach((item, position) => {
    const end = found[position + 1]?.index ?? text.length;
    const segment = text.slice(item.index + item.label.length, end).replace(/^[\s:–-]+|[\s,.;:–-]+$/gu, '');
    const evidence = text.slice(item.index, end).trim();
    if (!segment) return;
    const kind = FIELDS[item.field].kind;
    if (kind === 'vehicle') {
      const latin = segment.match(/[A-Za-z][A-Za-z0-9 ]*[A-Za-z0-9]/)?.[0];
      if (latin) operations.push({ type: 'report_current_vehicle', hasCar: true, name: latin.trim(), evidence });
      else if (negation(segment)) operations.push({ type: 'report_current_vehicle', hasCar: false, evidence });
    } else if (kind === 'name') {
      const name = withoutSourceLabel(segment);
      if (name && name.length <= 120 && !/\d/.test(name)) operations.push({ type: 'report_fact', field: item.field as 'display_name', value: name, evidence });
    } else {
      const numbers = [...new Set(numbersIn(segment))];
      const value = numbers.length === 1 ? numbers[0] : !numbers.length && negation(segment) ? 0 : undefined;
      if (value !== undefined) operations.push({ type: 'report_fact', field: item.field as Exclude<FactField, 'current_vehicle_id'>, value, evidence });
    }
  });
  return operations;
}

const shekels = (value: number) => `${Math.abs(displayShekels(value)).toLocaleString('he-IL')} ₪`;
function formatValue(field: keyof EmployeeDataInput, values: Values, names: Map<string, string>, occupation?: AdvisorOccupation) {
  const value = values[field as keyof Values];
  // "No company car" is the waiver baseline; its allowance always comes from the official occupation record.
  if (field === 'current_vehicle_id') return value === null
    ? occupation?.waiver_allowed ? `אין רכב צמוד (ויתור, אחזקה לפי כללי החברה ${occupation.waiver_maintenance_amount.toLocaleString('he-IL')} ₪)` : 'אין רכב צמוד'
    : names.get(String(value)) ?? String(value);
  if (field === 'display_name' || field === 'occupation_title') return String(value);
  const kind = FIELDS[field as FactField]?.kind;
  if (kind === 'money') return `${Number(value).toLocaleString('he-IL')} ₪`;
  if (kind === 'percent') return `${Number(value).toLocaleString('he-IL')}%`;
  return Number(value).toLocaleString('he-IL');
}
const label = (field: keyof EmployeeDataInput) => field === 'occupation_title' ? 'תפקיד' : FIELDS[field as FactField].label;
function scenarioView(kind: 'vehicle' | 'waiver', car: Car | null, name: string, result: Calculation | null,
  eligible: boolean, reason: string, baselineNet: number | null, participation?: number, vehicleId?: string): CalculationScenario {
  // Display values in whole shekels. The delta is the difference of the displayed nets, as in the official
  // worksheet, so the shown numbers add up. Unrounded results are kept in the immutable snapshot.
  const round = displayShekels;
  return { kind, vehicleId: car?.['מזהה'] ?? vehicleId ?? null, name, group_code: car?.['קבוצה'] ?? null, drive_type: car?.['הנעה'] ?? null,
    eligible, reason: reason.slice(0, 300), net: result ? round(result.net) : null,
    delta: result && baselineNet !== null ? round(result.net) - round(baselineNet) : null,
    participation: result ? round(result.participation) : participation ?? null,
    carValueOfUse: result ? round(result.carValueOfUse) : null, electricGrossUp: result ? round(result.electricGrossUp) : null,
    maintenance: result ? round(result.maintenance) : null, familyExtra: result ? round(result.familyExtra) : null,
    incomeTax: result ? round(result.incomeTax) : null };
}
/** Short, deterministic Hebrew explanation built only from calculator output. */
function explain(baseline: Calculation, scenario: CalculationScenario, result: Calculation) {
  // Same convention as the reference worksheet: difference of the displayed (rounded) nets.
  const delta = displayShekels(result.net) - displayShekels(baseline.net);
  const direction = delta === 0 ? 'הנטו כמעט לא משתנה' : `הנטו ${delta > 0 ? 'יעלה' : 'ירד'} ב־${shekels(delta)} בחודש`;
  // Most significant first: a gained or lost waiver allowance, value of use (tax), the electric benefit, participation.
  const factors: string[] = [];
  if (baseline.maintenance > 0 && result.maintenance === 0) factors.push(`אחזקת הרכב של ${shekels(baseline.maintenance)} ברוטו שמקבלים בוויתור מתבטלת`);
  if (result.maintenance > 0 && baseline.maintenance === 0) factors.push(`תתווסף אחזקת רכב של ${shekels(result.maintenance)} ברוטו (חייבת במס)`);
  const valueDiff = result.carValueOfUse - baseline.carValueOfUse;
  if (displayShekels(valueDiff) !== 0) factors.push(`שווי השימוש ${valueDiff > 0 ? 'גבוה' : 'נמוך'} יותר, ולכן המס ${valueDiff > 0 ? 'עולה' : 'יורד'}`);
  if (result.electricNetBonus > 0) factors.push(`יש הטבת רכב חשמלי של ${shekels(result.electricNetBonus)} נטו`);
  const participationDiff = result.participation - baseline.participation;
  if (displayShekels(participationDiff) !== 0) factors.push(`ההשתתפות ${participationDiff > 0 ? 'גבוהה' : 'נמוכה'} יותר ב־${shekels(participationDiff)}`);
  if (result.familyExtra > 0) factors.push(`חלקך בפער של המסלול המשפחתי הוא ${shekels(result.familyExtra)}`);
  const top = factors.slice(0, 3);
  const reasons = top.length > 1 ? `${top.slice(0, -1).join(', ')}, ו${top.at(-1)}` : top[0];
  return `• ${scenario.name}: ${direction}${reasons ? `. ${reasons}` : ''}.`;
}

/* ---------- The financial step of a turn ---------- */

export type FinancialInput = {
  userId: string; conversationId: string; latest: ConversationMessageRow; state: AdvisorState;
  occupation?: AdvisorOccupation; approvalCode?: string; notes: FinancialNote[]; waiver: boolean;
  /** Vehicles were chosen or named in this turn; a waiver question then also compares them. */
  vehiclesNamedNow?: boolean;
  /** Facts accepted and fields marked unknown in this turn, for a brief acknowledgement. */
  accepted?: number; unknownNow?: FactField[];
  /** Confirmed values the employee disputed in this turn. */
  disputedNow?: FactField[];
  /** The turn advanced something else (e.g. a vehicle was selected), so a repeated question is not a failed ask. */
  progressed?: boolean;
  /** Save an approved summary and stop: the turn answers the question the update came with (e.g. eligibility). */
  stopAfterSave?: boolean;
  /** false: nothing in this turn asks for a calculation, so an unchanged approved profile is not recalculated. */
  calculate?: boolean;
};
export type FinancialOutcome = Pick<CatalogMessage, 'approval' | 'calculation' | 'actions'> & {
  text: string; offerRepresentative?: string;
};

const rulesMeta = z.object({ version: z.string().min(1).max(120), netMethod: z.object({ taxYear: z.number().int() }).passthrough() }).passthrough();

/** Read-only salary scenario: reuse the calculator/adapters, never the profile approval/write path. */
/** vehicleIds: the cars named in the scenario message itself ("עם ה־ATTO 3"); otherwise the cars already chosen. */
export async function simulateSalary(userId:string,state:AdvisorState,salary:number,occupations:AdvisorOccupation[],deps:FinancialDependencies,vehicleIds?:string[]):Promise<string> {
  if (!Number.isFinite(salary)||salary<1000||salary>FIELDS.base_salary.max) return 'לסימולציה צריך שכר בסיס חודשי ברוטו תקין בשקלים. מה הסכום המלא?';
  if (state.pendingFacts.length||state.pendingApproval||state.disputedFacts?.length||state.unknownFacts?.length) {
    return 'אפשר לבדוק שינוי שכר, אבל קודם צריך להשלים או לאשר את הפרטים שממתינים בשיחה. שום פרט לא השתנה; אפשר להמשיך מהשאלה הקודמת.';
  }
  try {
    const profile=await deps.confirmed(userId);
    if (!profile||profile.user_id!==userId||profile.status!=='confirmed') return 'כדי לדמות שינוי בשכר צריך קודם פרופיל מאושר עם פרטי החישוב. עדיין לא חישבתי ולא שיניתי שום פרט.';
    const role=occupations.find(row=>row.title===profile.occupation_title);
    // Do not coerce missing numeric inputs to zero, even if an upstream adapter accepts numeric strings.
    if (!role||numeric.some(field=>profile[field]===null||profile[field]===undefined||!Number.isFinite(Number(profile[field])))||
      profile.current_vehicle_id===undefined) return 'חסרים פרטים מאושרים או נתוני תפקיד לחישוב בטוח. צריך להשלים אותם לפני הסימולציה; לא אחליף מידע חסר באפס.';
    if (state.occupation?.match&&state.occupation.match.title!==role.title) return 'יש בשיחה תפקיד שונה מהפרופיל המאושר. צריך לברר ולאשר את התפקיד לפני סימולציה כספית; לא שיניתי את הפרופיל.';
    const waiver=!vehicleIds?.length&&(state.activeGoal?.kind==='waiver'||(!state.activeGoal&&state.goal==='waiver'));
    const selected=vehicleIds?.length?vehicleIds:state.activeGoal?.kind==='vehicles'?state.activeGoal.vehicleIds:state.selectedVehicleIds??[];
    if (!waiver&&!selected.length) return 'לאיזה רכב לבדוק את השכר הזה? אפשר לכתוב שם של דגם, או לבדוק ויתור על רכב.';
    const rules=await deps.rules();rulesMeta.parse(rules);
    const occupation=toCalculatorOccupation(role);
    const approved=toCalculatorEmployee(profile,role);
    const assumed=toCalculatorEmployee({...profile,base_salary:salary},role);
    const rows=waiver?new Map<string,{car:Car}|{error:'not_found'|'tax_value_missing'}>():await deps.vehicles(selected);
    const lines:string[]=[];
    for (const id of waiver?[null]:selected.slice(0,6)) {
      const found=id?rows.get(id):undefined;
      if (id&&(!found||'error' in found)) return 'חסרים רכב פעיל או נתוני מס רשמיים לסימולציה. אפשר להמשיך בבחירה הקודמת או לפנות לנציג; עדיין לא חישבתי.';
      const car=found&&'car' in found?found.car:null;
      const choice:Choice=car?{type:'car',car}:{type:'waiver'};
      const allowed=eligibility(assumed,choice,rules,occupation);
      const previousAllowed=eligibility(approved,choice,rules,occupation);
      if (!allowed.eligible||!previousAllowed.eligible) return `לא ניתן לחשב את האפשרות הזו לפי התפקיד המאושר וכללי החברה: ${!allowed.eligible?allowed.reason:previousAllowed.reason}.`;
      const previous=displayShekels(calculateNet(approved,choice,rules,occupation).net);
      const net=displayShekels(calculateNet(assumed,choice,rules,occupation).net);
      const delta=net-previous;
      lines.push(`• ${car?car['דגם (כינוי מסחרי)']:'ויתור על רכב'}: נטו של כ־${shekels(net)} בחודש, לעומת ${shekels(previous)} עם השכר המאושר (${delta>=0?'+':'−'}${shekels(delta)}).`);
    }
    return `בדקתי לפי שכר בסיס של ${shekels(salary)} ברוטו, ושאר הפרטים כפי שאישרת:\n${lines.join('\n')}\nזו הערכה בלבד, והפרטים השמורים שלך נשארו כמו שהם.`;
  } catch {return 'לא הצלחתי לטעון את כל הנתונים לסימולציה בטוחה כרגע. לא חושבה תוצאה ולא השתנה שום פרט; אפשר לנסות שוב בהמשך.';}
}

export async function advanceFinancialFlow(input: FinancialInput, deps: FinancialDependencies): Promise<FinancialOutcome> {
  const { state, latest, userId } = input;
  const say = (text: string, extra: Partial<FinancialOutcome> = {}): FinancialOutcome => ({ text: text.slice(0, 1600), ...extra });
  const stopAsking = () => { delete state.pendingField; delete state.pendingFieldAsks; };
  if (!input.occupation) {
    stopAsking();
    state.pendingQuestion = 'occupation';
    return say('כדי לחשב את הנטו צריך לדעת מה התפקיד שלך בשטראוס. מה התפקיד שלך?');
  }
  let confirmed: EmployeeDataVersionRow | null;
  try { confirmed = await deps.confirmed(userId); }
  catch { return say('לא הצלחתי לטעון את הפרופיל שלך כרגע, ולכן אי אפשר לחשב. אפשר לנסות שוב עוד רגע?'); }
  if (confirmed && confirmed.user_id !== userId) throw new Error('Foreign employee profile');
  let accountName: string | null = null;
  try { accountName = (await deps.accountName?.(userId)) ?? null; } catch { /* Without it, the name is asked as before. */ }
  const proposal = buildProposal(confirmed, state, input.occupation, accountName);

  // 1. Missing values: exactly one question per turn, never a default value.
  const missing = proposal.missing.filter((field): field is FactField => field !== 'occupation_title');
  // Only clarifications the employee can act on: about a missing value, or a value they explicitly wrote.
  // A model misreading about an already-known value is dropped, so a confirmed value is never asked again.
  const notes = input.notes.filter(note => !note.field || missing.includes(note.field) || note.explicit);
  if (notes.length < input.notes.length) console.info('[carwise.ai.financial]', { droppedNotes: input.notes.length - notes.length });
  if (missing.length) {
    // Back to collecting: an earlier summary is no longer the proposal, so its approval button cannot apply.
    delete state.pendingApproval;
    // Fields already sent to a representative are not asked again while their request is open; other questions continue.
    const awaiting = awaitedRepresentativeFields(state).filter(field => missing.includes(field));
    const unknown = missing.filter(field => state.unknownFacts?.includes(field) || awaiting.includes(field));
    const next = nextQuestion(missing, unknown);
    const firstQuestion = !state.pendingField && !input.accepted && !notes.length;
    const parts: string[] = [];
    let offerRepresentative: string | undefined;
    const justUnknown = (input.unknownNow ?? []).filter(field => unknown.includes(field));
    const disputedNow = (input.disputedNow ?? []).filter(field => missing.includes(field));
    if (justUnknown.length && disputedNow.includes(justUnknown[0])) {
      parts.push(`אין בעיה. לא אשתמש בערך הקודם של ${FIELDS[justUnknown[0]].about}, ולא אנחש ערך אחר. הערך הנכון מופיע בתלוש השכר או אצל צוות השכר. אפשר גם לפנות לנציג, שיבדוק מול מקור רשמי.`);
      offerRepresentative = topicFor(justUnknown[0]);
    } else if (justUnknown.length) {
      parts.push(`אין בעיה. בלי ${FIELDS[justUnknown[0]].about} אי אפשר לחשב נטו מדויק, ולא אנחש. אפשר לבדוק בתלוש השכר, או להיעזר בנציג.`);
      offerRepresentative = topicFor(justUnknown[0]);
    } else if (notes.length) parts.push(notes.map(note => note.text).join(' '));
    else if (disputedNow.length) parts.push(`בסדר, לא אשתמש בערך הקודם של ${FIELDS[disputedNow[0]].about}.`);
    else if (input.accepted) parts.push(ACKS[state.revision % ACKS.length]);
    else if (firstQuestion) parts.push('כדי לחשב כמה זה ישפיע על הנטו שלך, נצטרך להשלים כמה פרטים.');
    // A clarification that already asks something is the single question of this turn.
    const clarifying = !justUnknown.length && notes.some(note => note.text.trim().endsWith('?'));
    if (!next) {
      // The value still awaited is the one "on screen": a later short answer ("7%") belongs to it.
      state.pendingField = unknown[0]; state.pendingFieldAsks = 1;
      state.pendingQuestion = 'financial';
      if (awaiting.length && unknown.every(field => awaiting.includes(field))) {
        parts.push(`כל שאר הפרטים כבר אצלי. ממתינים לתשובת הנציג לגבי ${awaiting.map(field => FIELDS[field].about).join(' ו')}; אם הפרט ידוע לך בינתיים, אפשר לכתוב אותו כאן.`);
        return { text: parts.join(' ').slice(0, 1600) };
      }
      if (!justUnknown.length) parts.push(`כדי לחשב חסר לי רק ${unknown.map(field => FIELDS[field].about).join(' ו')}. אפשר לבדוק בתלוש השכר ולכתוב לי, או להיעזר בנציג.`);
      // A representative is offered for a field nobody is checking yet (one already sent is not requested twice).
      return { text: parts.join(' ').slice(0, 1600), offerRepresentative: topicFor(unknown.find(field => !awaiting.includes(field)) ?? unknown[0]) };
    }
    state.pendingQuestion = 'financial';
    state.pendingFieldAsks = state.pendingField !== next ? 1 : (state.pendingFieldAsks ?? 1) + (input.progressed ? 0 : 1);
    state.pendingField = next;
    if (!clarifying) parts.push(justUnknown.length ? `בינתיים, ${FIELDS[next].ask}` : FIELDS[next].ask);
    // Avoid an endless loop on a value the employee cannot provide.
    if (state.pendingFieldAsks >= 3) { parts.push('אם קשה לברר את זה, נציג יכול לעזור.'); offerRepresentative = topicFor(next); }
    return { text: parts.join(' ').slice(0, 1600), offerRepresentative };
  }
  // An explicit but invalid correction of a known value is this turn's single stage: ask it, calculate nothing.
  if (notes.length) {
    const field = notes.find(note => note.field)?.field;
    const text = notes.map(note => note.text).join(' ');
    state.pendingQuestion = 'financial';
    if (field) { state.pendingField = field; state.pendingFieldAsks = 1; }
    return say(text.trim().endsWith('?') || !field ? text : `${text} ${FIELDS[field].ask}`);
  }
  stopAsking();

  // 2. Explicit approval of the exact proposal before any profile write.
  const code = proposalCode(proposal.values, confirmed?.id ?? null, state.disputedFacts ?? []);
  let profile = confirmed;
  let approvedNow = false;
  if (proposal.changed) {
    const valid = input.approvalCode && state.pendingApproval?.code === input.approvalCode && input.approvalCode === code;
    if (!valid) {
      let names = new Map<string, string>();
      if (typeof proposal.values.current_vehicle_id === 'string') {
        try {
          const found = (await deps.vehicles([proposal.values.current_vehicle_id])).get(proposal.values.current_vehicle_id);
          if (found && 'car' in found) names = new Map([[proposal.values.current_vehicle_id, found.car['דגם (כינוי מסחרי)']]]);
        } catch { /* The ID is still shown. */ }
      }
      const fields: Array<keyof EmployeeDataInput> = ['occupation_title', 'base_salary', 'commissions', 'bonus', 'employee_pension_percent',
        'employee_study_fund_percent', 'tax_credit_points', 'current_vehicle_id', 'current_participation', 'eligible_children_count', 'display_name'];
      state.pendingApproval = { code, basedOnVersionId: confirmed?.id ?? null };
      state.pendingQuestion = 'approval';
      const opening = input.approvalCode ? 'הפרטים השתנו מאז הסיכום הקודם, אז לא שמרתי כלום. הנה סיכום מעודכן לאישור.'
        : confirmed ? 'עדכנתי. הנה הפרטים לאישור, והגרסה הקודמת תישמר בהיסטוריה.'
        : 'מעולה, יש לי את כל הפרטים! 🙌 הנה סיכום. אחרי האישור אשמור אותם בפרופיל ואחשב את הנטו.';
      // An allowance the employee wrote is never stored or added: the official one is used, and a difference is said.
      const stated = latest.body.match(/אחזקה[^\d]{0,12}(\d{1,3}(?:,\d{3})+|\d+)/u)?.[1];
      const official = input.occupation.waiver_allowed ? input.occupation.waiver_maintenance_amount : 0;
      const allowanceNote = stated && proposal.values.current_vehicle_id === null && Number(stated.replace(/,/g, '')) !== official
        ? `\nחשוב לדעת: נכתבה אחזקה של ${Number(stated.replace(/,/g, '')).toLocaleString('he-IL')} ₪, אבל בחישוב תילקח האחזקה לפי כללי החברה לתפקיד (${official.toLocaleString('he-IL')} ₪).` : '';
      return say(`${opening}\nהפרטים מבוססים על מה שמסרת, ולא נבדקו מול מערכת השכר. אם משהו לא נכון, אפשר לכתוב לי מה לתקן.${allowanceNote}`, {
        approval: { code, basedOnVersion: confirmed?.version ?? null,
          rows: fields.map(field => ({ label: label(field), value: formatValue(field, proposal.values, names, input.occupation).slice(0, 120), status: proposal.status[field] ?? 'new' })) },
        actions: [{ label: 'אישור ושמירת הפרטים', body: `אישור פרטי הפרופיל לפי הסיכום #${code}`, primary: true },
          { label: 'יש פרט לתיקון', body: CORRECTION_REQUEST }]
      });
    }
    try {
      // Idempotent: a retried turn reuses its own unconfirmed draft or recognises an identical confirmation.
      const versions = await deps.versions(userId);
      const draft = versions.find(row => row.user_id === userId && row.status === 'draft' && row.version > (confirmed?.version ?? 0) && sameProfile(row, proposal.values));
      const row = draft ?? await deps.createVersion(userId, toInput(proposal.values));
      profile = await deps.confirmVersion(userId, row.id);
      if (!profile) {
        const latestConfirmed = await deps.confirmed(userId);
        if (latestConfirmed && sameProfile(latestConfirmed, proposal.values)) profile = latestConfirmed;
      }
    } catch { profile = null; }
    if (!profile || profile.user_id !== userId || profile.status !== 'confirmed' || !sameProfile(profile, proposal.values)) {
      return say('משהו השתבש בשמירת הפרטים, אז עדיין לא חישבתי. שום נתון לא השתנה, ואפשר לנסות שוב.');
    }
    approvedNow = true;
    state.pendingFacts = []; state.unknownFacts = []; state.disputedFacts = []; delete state.pendingApproval;
  } else if (input.approvalCode) {
    delete state.pendingApproval;
  }
  if (!profile) throw new Error('Confirmed profile expected');
  state.confirmedVersion = { id: profile.id, version: profile.version };
  const savedText = approvedNow ? 'שמרתי את הפרטים ✓ ' : '';

  if (input.stopAfterSave && approvedNow) return say('שמרתי את הפרטים ✓ הפרופיל עודכן.');
  // The last calculation is not the default answer: without a request for one in this turn, nothing is recalculated.
  if (input.calculate === false && !approvedNow) return say('');

  // 3. Which alternatives to calculate.
  const shown = state.shownVehicles ?? [];
  // A waiver question is answered on its own; earlier car results are repeated only when cars are named now.
  const waiverOnly = input.waiver && !input.vehiclesNamedNow;
  let selected = waiverOnly ? [] : state.selectedVehicleIds ?? [];
  if (!selected.length && !input.waiver) {
    // Up to three cars on screen answer "how much in net?" directly (existing flow). With more, the employee chooses;
    // "all of them" is offered only when they fit in one comparison, so a longer list is never cut down silently.
    if (shown.length && shown.length <= 3) selected = shown.map(vehicle => vehicle.id);
    else if (shown.length) {
      state.pendingQuestion = 'vehicle_selection';
      // The buttons are only the first cars shown: any catalog car can be named instead.
      return say(`${savedText}לאילו רכבים לחשב את הנטו? אפשר לבחור אחד או כמה${shown.length > 6 ? ' (עד 6)' : ''}, או לכתוב שם של דגם אחר מהקטלוג.`, {
        actions: [...(shown.length <= 6 ? [{ label: 'כל הרכבים שהוצגו', body: 'חישוב נטו לכל הרכבים שהוצגו', primary: true }] : []),
          ...shown.slice(0, 6).map(vehicle => ({ label: vehicle.name.slice(0, 60), body: `חישוב נטו עבור ${vehicle.name} (${vehicle.id})`.slice(0, 200) }))].slice(0, 8)
      });
    } else {
      state.pendingQuestion = 'vehicle_selection';
      return say(`${savedText}לאיזה רכב להשוות? אפשר לכתוב דגם או סוג הנעה.`);
    }
  }
  if (!waiverOnly) state.selectedVehicleIds = selected; // The saved car choice survives a waiver question.

  // 4. Deterministic calculation with official rules, catalog rows and tax values.
  let rules: CalculationRules;
  let meta: z.infer<typeof rulesMeta>;
  try { rules = await deps.rules(); meta = rulesMeta.parse(rules); }
  catch { return say(`${savedText}כללי החישוב לא זמינים כרגע, ולכן אי אפשר לתת תוצאה מדויקת. אפשר לנסות שוב עוד מעט.`); }
  const occupation = toCalculatorOccupation(input.occupation);
  const employee = toCalculatorEmployee(profile, input.occupation);
  const baselineId = profile.current_vehicle_id;
  const ids = [...new Set([...(baselineId ? [baselineId] : []), ...selected])];
  let lookup: VehicleLookup;
  try { lookup = await deps.vehicles(ids); }
  catch { return say(`${savedText}קטלוג הרכבים לא זמין לי כרגע, אז עוד לא חישבתי. אפשר לנסות שוב עוד מעט.`); }

  let baselineChoice: Choice;
  let baselineName: string;
  let baselineCar: Car | null = null;
  if (baselineId) {
    const found = lookup.get(baselineId);
    if (!found || 'error' in found) {
      return say(`${savedText}${found && 'error' in found && found.error === 'tax_value_missing' ? 'לרכב שלך היום אין ערך שווי שימוש רשמי ברשימות המס' : 'הרכב שרשום לך היום לא מופיע בקטלוג הרכבים של החברה'}, ולכן אי אפשר לחשב את המצב הנוכחי ולהשוות אליו. נציג יכול לבדוק את פרטי הרכב.`, { offerRepresentative: 'בדיקת הרכב הנוכחי לחישוב' });
    }
    baselineCar = found.car;
    baselineChoice = { type: 'car', car: found.car, participation: employee['השתתפות היום'] };
    baselineName = `היום: ${found.car['דגם (כינוי מסחרי)']}`;
  } else { baselineChoice = { type: 'waiver' }; baselineName = 'היום: ויתור על רכב'; }
  const baselineEligibility = eligibility(employee, baselineChoice, rules, occupation);
  if (!baselineEligibility.eligible) {
    return say(`${savedText}המצב שרשום לך היום (${baselineName.replace('היום: ', '')}) לא תואם לכללי החברה: ${baselineEligibility.reason}. כדי לא לחשב מנתונים שגויים, כדאי שנציג יבדוק את זה.`, { offerRepresentative: 'בירור המצב הנוכחי לחישוב נטו' });
  }
  const baseline = calculateNet(employee, baselineChoice, rules, occupation);
  const scenarios: Array<{ view: CalculationScenario; result: Calculation | null; car: Car | null; choice: Choice | null }> = [];
  for (const id of selected.filter(id => id !== baselineId)) {
    const found = lookup.get(id);
    const name = shown.find(vehicle => vehicle.id === id)?.name ?? id;
    if (!found || 'error' in found) {
      const reason = found && 'error' in found && found.error === 'tax_value_missing' ? 'חסר לרכב ערך שווי שימוש רשמי, אז לא חישבתי אותו' : 'הרכב לא מופיע בקטלוג הרכבים של החברה';
      scenarios.push({ view: scenarioView('vehicle', null, name, null, false, reason, null, undefined, id), result: null, car: null, choice: null });
      continue;
    }
    const choice: Choice = { type: 'car', car: found.car };
    const allowed = eligibility(employee, choice, rules, occupation);
    const result = allowed.eligible ? calculateNet(employee, choice, rules, occupation) : null;
    scenarios.push({ view: scenarioView('vehicle', found.car, found.car['דגם (כינוי מסחרי)'], result, allowed.eligible, allowed.reason, baseline.net), result, car: found.car, choice });
  }
  if (input.waiver && baselineChoice.type !== 'waiver') {
    const choice: Choice = { type: 'waiver' };
    const allowed = eligibility(employee, choice, rules, occupation);
    const result = allowed.eligible ? calculateNet(employee, choice, rules, occupation) : null;
    scenarios.push({ view: scenarioView('waiver', null, 'ויתור על רכב', result, allowed.eligible, allowed.reason, baseline.net), result, car: null, choice });
  }
  if (!scenarios.length && waiverOnly) {
    return say(`${savedText}כבר היום אין לך רכב צמוד, אז ויתור לא ישנה את הנטו שלך. רוצה לבדוק רכב מהקטלוג?`);
  }
  if (!scenarios.length) {
    // The selected car is the one the employee has today: no vehicle change and no difference to show. The choice is
    // kept, and the next car the employee names is ADDED to it for a real comparison.
    state.pendingQuestion = 'comparison';
    return say(`${savedText}זה הרכב שכבר יש לך היום, אז אין שינוי בנטו. לאיזה רכב אחר להשוות?`);
  }

  // 5. Immutable snapshot, once per identical calculation (state first, then saved history for retried turns).
  const key = createHash('sha256').update(JSON.stringify({ profile: profile.id, rules: meta.version, calculator: CALCULATOR_VERSION,
    baseline: baselineId ?? 'WAIVER', vehicles: [...selected].sort(), waiver: input.waiver })).digest('hex');
  const persistable = scenarios.filter(item => item.car || item.view.kind === 'waiver');
  let runId: string | null = state.calculations?.find(item => item.key === key)?.runId ?? null;
  if (!runId && persistable.length) {
    try {
      runId = (await deps.history(userId, input.conversationId)).find(run => run.input_snapshot?.idempotency_key === key)?.id ?? null;
      runId ??= await deps.snapshot({ conversationId: input.conversationId, employeeDataVersionId: profile.id,
        calculatorVersion: CALCULATOR_VERSION, rulesVersion: meta.version, taxYear: meta.netMethod.taxYear,
        inputSnapshot: { idempotency_key: key, employee, occupation, profile_version: profile.version, rules },
        baselineSnapshot: { choice: baselineChoice.type, vehicle_id: baselineId, vehicle: baselineCar, participation: employee['השתתפות היום'], result: baseline },
        scenarios: persistable.map((item, index) => ({ ordinal: index + 1, choiceType: item.view.kind, vehicleId: item.car?.['מזהה'] ?? null,
          vehicleSnapshot: item.car, eligible: item.view.eligible,
          resultSnapshot: item.result ? { ...item.result } : { reason: item.view.reason },
          netDelta: item.result ? item.result.net - baseline.net : null })) });
    } catch { runId = null; }
  }
  if (runId) state.calculations = [...(state.calculations ?? []).filter(item => item.key !== key),
    { key, runId, profileVersionId: profile.id, vehicleIds: selected, waiver: input.waiver }].slice(-20);
  state.pendingQuestion = null;

  const lines = scenarios.map(item => item.result ? explain(baseline, item.view, item.result) : `• ${item.view.name}: לא אפשרי, ${item.view.reason}.`);
  // Several alternatives: name the one with the highest computed net (from the calculator, never from the price).
  const computed = scenarios.filter(item => item.result && item.view.delta !== null);
  if (computed.length > 1) {
    const best = computed.reduce((top, item) => item.view.delta! > top.view.delta! ? item : top);
    const delta = best.view.delta!;
    lines.push(`הכי משתלם בנטו: ${best.view.name} (${delta === 0 ? 'בלי שינוי בנטו' : `הנטו ${delta > 0 ? 'יעלה' : 'ירד'} ב־${shekels(delta)} בחודש`} לעומת היום).`);
  }
  const baselineView = scenarioView(baselineChoice.type === 'car' ? 'vehicle' : 'waiver', baselineCar, baselineName, baseline, true, baselineEligibility.reason, baseline.net);
  // A waiver the approved role does not allow is answered as a plain refusal, not as a calculation result.
  const refusedWaiver = waiverOnly && scenarios.length === 1 && scenarios[0].view.kind === 'waiver' && !scenarios[0].result;
  const today = `${baselineChoice.type === 'waiver' ? 'היום, בלי רכב צמוד' : `היום, עם ${baselineName.replace('היום: ', '')}`}, הנטו שלך הוא בערך ${shekels(baseline.net)} בחודש`;
  const body = refusedWaiver
    ? `לצערי, לפי התפקיד המאושר שלך (${input.occupation.title}) וכללי החברה, אי אפשר לוותר על הרכב הצמוד: ${scenarios[0].view.reason}.\n` +
      `${today}, וזה לא משתנה. אפשר להמשיך לבחור ולהשוות רכבים שמתאימים לך.\n`
    : `הנה החישוב 👇\n${today}.\n${lines.join('\n')}\n`;
  return say(`${savedText}${body}` +
    'החישוב לפי הפרטים שאישרת וכללי החברה. זו הערכה ולא תלוש שכר.' +
    (runId ? '' : ' (לא הצלחתי לשמור את החישוב בהיסטוריה.)'), {
    calculation: { runId, saved: Boolean(runId), profileVersion: profile.version, rulesVersion: meta.version, taxYear: meta.netMethod.taxYear,
      baseline: baselineView, scenarios: scenarios.map(item => item.view).slice(0, 6) },
    actions: input.state.occupation?.match?.waiver_allowed && !input.waiver && baselineChoice.type !== 'waiver'
      ? [{ label: 'מה אם אוותר על הרכב?', body: 'מה יקרה לנטו אם אוותר על רכב?' }] : undefined
  });
}
