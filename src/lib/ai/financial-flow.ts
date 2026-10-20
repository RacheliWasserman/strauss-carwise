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
import type { AdvisorState, FactField } from './advisor-state';

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
      const result: VehicleLookup = new Map();
      for (const id of ids) {
        const row = rows.find(item => item.id === id);
        if (!row) { result.set(id, { error: 'not_found' }); continue; }
        // The official tax lookup throws unless exactly one record exists. Never substitute a value.
        try { result.set(id, { car: await vehicles.toCalculatorCar(row) }); }
        catch { result.set(id, { error: 'tax_value_missing' }); }
      }
      return result;
    },
    async findVehicles(name) {
      return (await searchAdvisorVehicles({ name, limit: 10 })).vehicles;
    },
    history: (userId, conversationId) => history.listCalculationHistory(userId, conversationId),
    snapshot: input => history.createCalculationSnapshot(input)
  };
}

/* ---------- Field definitions ---------- */

type Kind = 'name' | 'money' | 'percent' | 'points' | 'count' | 'vehicle';
// `about` is the plain-language noun used inside sentences ("לא הצלחתי להבין את ...").
const FIELDS: Record<FactField, { label: string; ask: string; about: string; kind: Kind; max: number }> = {
  base_salary: { label: 'שכר בסיס חודשי ברוטו', ask: 'מה שכר הבסיס החודשי שלך ברוטו?', about: 'שכר הבסיס', kind: 'money', max: 1_000_000 },
  commissions: { label: 'עמלות חודשיות', ask: 'יש לך עמלות חודשיות? אם לא, כתבי 0.', about: 'העמלות', kind: 'money', max: 1_000_000 },
  bonus: { label: 'בונוס חודשי', ask: 'ובונוס חודשי? אם אין, כתבי 0.', about: 'הבונוס', kind: 'money', max: 1_000_000 },
  employee_pension_percent: { label: 'הפרשה לפנסיה', ask: 'כמה אחוזים מהשכר את מפרישה לפנסיה? (למשל 6%)', about: 'ההפרשה לפנסיה', kind: 'percent', max: 30 },
  employee_study_fund_percent: { label: 'הפרשה לקרן השתלמות', ask: 'ולקרן השתלמות, כמה אחוזים? אם אין, כתבי 0.', about: 'ההפרשה לקרן השתלמות', kind: 'percent', max: 30 },
  tax_credit_points: { label: 'נקודות זיכוי', ask: 'כמה נקודות זיכוי יש לך? המספר מופיע בתלוש השכר.', about: 'נקודות הזיכוי', kind: 'points', max: 50 },
  current_vehicle_id: { label: 'הרכב הצמוד היום', ask: 'יש לך היום רכב צמוד מהחברה? אם כן, כתבי את הדגם.', about: 'הרכב הנוכחי', kind: 'vehicle', max: 0 },
  current_participation: { label: 'השתתפות חודשית ברכב היום', ask: 'כמה את משלמת היום בחודש כהשתתפות ברכב?', about: 'ההשתתפות ברכב', kind: 'money', max: 100_000 },
  eligible_children_count: { label: 'ילדים עד גיל 23', ask: 'כמה ילדים עד גיל 23 יש לך? (זה חשוב לבדיקת המסלול המשפחתי)', about: 'מספר הילדים', kind: 'count', max: 40 },
  display_name: { label: 'שם בפרופיל', ask: 'ולסיום, איך לרשום את שמך בפרופיל?', about: 'השם', kind: 'name', max: 120 }
};
/** Every field is required for a stored profile version (all NOT NULL). Asked one at a time, in this order. */
export const PROFILE_ORDER: FactField[] = ['base_salary', 'commissions', 'bonus', 'employee_pension_percent',
  'employee_study_fund_percent', 'tax_credit_points', 'current_vehicle_id', 'current_participation',
  'eligible_children_count', 'display_name'];
/** The next single question. A dependent field waits for the field it depends on. */
export function nextQuestion(missing: FactField[], unknown: FactField[] = []): FactField | undefined {
  return missing.find(field => !unknown.includes(field) &&
    !(field === 'current_participation' && missing.includes('current_vehicle_id')));
}
const ACKS = ['מעולה!', 'מצוין.', 'תודה!', 'קיבלתי.'];

/* ---------- Fact validation against the employee's own words ---------- */

const WORDS: Record<string, number> = { אפס: 0, אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלוש: 3, שלושה: 3,
  ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10 };

/** Numbers literally present in text: 18,000 / 18000 / 18 אלף / 2.25 / 2 וחצי / שלושה. */
export function numbersIn(text: string): number[] {
  const found: number[] = [];
  // Digits glued to Latin letters are model names ("MG4", "EV3", "ATTO3"), never amounts.
  for (const match of text.matchAll(/(?<![A-Za-z\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s*(?:אלף|k|K)(?![\p{L}]))?(\s*וחצי)?/gu)) {
    if (!match[3] && /^[A-Za-z]/.test(text.slice(match.index! + match[0].length))) continue;
    let value = Number(match[1].replace(/,/g, '') + (match[2] ? '.' + match[2] : ''));
    if (match[4]) value += 0.5;
    if (match[3]) value *= 1000;
    found.push(value);
  }
  for (const match of text.matchAll(/(?:^|[^\p{L}])[וה]?(\p{L}+)(\s+וחצי)?(?=$|[^\p{L}])/gu)) {
    const value = WORDS[match[1]];
    if (value !== undefined) found.push(value + (match[2] ? 0.5 : 0));
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
    const name = String(value).trim();
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

function putFact(state: AdvisorState, field: FactField, value: string | number, sourceMessageId: string) {
  state.pendingFacts = state.pendingFacts.filter(fact => fact.field !== field);
  state.pendingFacts.push({ field, value, sourceMessageId, status: 'pending_confirmation' });
  state.unknownFacts = (state.unknownFacts ?? []).filter(item => item !== field);
}

/** Apply validated employee facts to conversation state only. Never writes a profile. Returns clarifications. */
/** A clarification about one field. explicit: the employee actually wrote a value (a number, "אין", a car name). */
export type FinancialNote = { field?: FactField; text: string; explicit: boolean };
export type AppliedFacts = { notes: FinancialNote[]; accepted: number; unknownNow: FactField[]; offerRepresentative?: string };
const explicitValue = (evidence: string) => numbersIn(evidence).length > 0 || negation(evidence);
// "מה יקרה אם אוותר על רכב?" describes a possible future, never the car situation today.
const hypothetical = (text: string) => /(?:^|[^\p{L}])(?:אם|מה יקרה|מה יהיה|במקרה ש)(?=$|[^\p{L}])/u.test(text);
const CURRENT_CAR_FIELDS: FactField[] = ['current_vehicle_id', 'current_participation'];

/**
 * A short direct answer to the single question on screen ("18 אלף", "אין", "לא יודעת") is understood by the
 * server even when the model returned no operation. It goes through the same evidence and range checks.
 */
function answerPendingField(state: AdvisorState, latest: ConversationMessageRow, result: AppliedFacts) {
  const field = state.pendingField;
  const body = latest.body.trim();
  if (!field || body.length > 40 || body.includes('?')) return;
  if (/(?:^|[^\p{L}])לא\s+(?:יודע|יודעת|זוכר|זוכרת|בטוח|בטוחה)(?=$|[^\p{L}])/u.test(body)) {
    state.pendingFacts = state.pendingFacts.filter(fact => fact.field !== field);
    state.unknownFacts = [...new Set([...(state.unknownFacts ?? []), field])];
    result.unknownNow.push(field);
    return;
  }
  const kind = FIELDS[field].kind;
  if (kind === 'name') return;
  if (kind === 'vehicle') {
    if (negation(body) && !numbersIn(body).length) { putFact(state, field, 'NONE', latest.id); result.accepted++; }
    return;
  }
  const numbers = [...new Set(numbersIn(body))];
  const value = numbers.length === 1 ? numbers[0] : numbers.length === 0 && negation(body) && field !== 'base_salary' ? 0 : undefined;
  if (value === undefined) return;
  const checked = checkFact(field, value, body);
  if (checked.ok) { putFact(state, field, checked.value, latest.id); result.accepted++; } else result.notes.push({ field, text: checked.note, explicit: true });
}

export async function applyFinancialOperations(state: AdvisorState, operations: FinancialOperation[], latest: ConversationMessageRow,
  deps: Pick<FinancialDependencies, 'findVehicles'>): Promise<AppliedFacts> {
  const result: AppliedFacts = { notes: [], accepted: 0, unknownNow: [] };
  const notes = result.notes;
  if (!operations.length) { answerPendingField(state, latest, result); return result; }
  const future = hypothetical(latest.body);
  for (const operation of operations) {
    if (!latest.body.includes(operation.evidence)) continue;
    // A hypothetical question never changes the current car or participation in the profile.
    if (future && (operation.type === 'report_current_vehicle' || (operation.type === 'report_fact' && CURRENT_CAR_FIELDS.includes(operation.field)))) continue;
    if (operation.type === 'report_fact') {
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
    } else if (operation.name) {
      // The name may be the catalog spelling of what the employee wrote (קורולה → COROLLA). It only selects among
      // active catalog rows and is shown in the approval summary before anything is saved.
      let matches: Array<{ id: string; display_name: string }>;
      try { matches = await deps.findVehicles(operation.name); }
      catch { notes.push({ field: 'current_vehicle_id', text: 'לא הצלחתי לבדוק את הרכב שלך בקטלוג כרגע.', explicit: true }); continue; }
      const exact = matches.filter(row => row.display_name.toLocaleLowerCase() === operation.name!.toLocaleLowerCase());
      const chosen = exact.length === 1 ? exact : matches;
      if (chosen.length === 1) { putFact(state, 'current_vehicle_id', chosen[0].id, latest.id); result.accepted++; }
      else if (chosen.length > 1) notes.push({ field: 'current_vehicle_id', text: `איזה מהם הרכב שלך היום: ${chosen.slice(0, 5).map(row => row.display_name).join(', ')}?`, explicit: true });
      else {
        notes.push({ field: 'current_vehicle_id', text: `לא מצאתי את "${operation.name}" בקטלוג הרכבים של החברה, אז אני לא יכולה לחשב ממנו את המצב היום. נציג יכול לבדוק את פרטי הרכב.`, explicit: true });
        result.offerRepresentative = 'בדיקת הרכב הנוכחי';
      }
    } else notes.push({ field: 'current_vehicle_id', text: 'איזה דגם הרכב שלך היום?', explicit: true });
  }
  return result;
}

/* ---------- Proposed profile ---------- */

type Values = Partial<Omit<EmployeeDataInput, 'current_vehicle_id'>> & { current_vehicle_id?: string | null };
type Status = 'confirmed' | 'new' | 'changed' | 'derived';
export type Proposal = { values: Values; status: Partial<Record<keyof EmployeeDataInput, Status>>; changed: boolean; missing: Array<FactField | 'occupation_title'> };
const numeric = ['base_salary', 'commissions', 'bonus', 'employee_pension_percent', 'employee_study_fund_percent',
  'tax_credit_points', 'eligible_children_count', 'current_participation'] as const;

export function buildProposal(confirmed: EmployeeDataVersionRow | null, state: AdvisorState, occupation?: AdvisorOccupation): Proposal {
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
  for (const fact of state.pendingFacts) set(fact.field, fact.field === 'current_vehicle_id' && fact.value === 'NONE' ? null : fact.value);
  // Participation belongs to the current car. A changed car without a new participation must be asked again.
  const carChanged = status.current_vehicle_id === 'new' || status.current_vehicle_id === 'changed';
  const participationReported = state.pendingFacts.some(fact => fact.field === 'current_participation');
  if (values.current_vehicle_id === null && !participationReported) { values.current_participation = 0; status.current_participation = confirmed && Number(confirmed.current_participation) === 0 ? 'confirmed' : 'derived'; }
  else if (carChanged && !participationReported) { delete values.current_participation; delete status.current_participation; }
  const missing: Proposal['missing'] = [];
  if (!values.occupation_title) missing.push('occupation_title');
  for (const field of PROFILE_ORDER) {
    if (field === 'current_vehicle_id' ? values.current_vehicle_id === undefined : values[field] === undefined) missing.push(field);
  }
  const changed = !confirmed || Object.values(status).some(item => item !== 'confirmed');
  return { values, status, changed, missing };
}

const canonical = (values: Values) => JSON.stringify(['display_name', 'occupation_title', ...numeric, 'current_vehicle_id']
  .map(key => [key, values[key as keyof Values] ?? null]));
/** Binds an approval to the exact values AND the confirmed version they were based on. */
export function proposalCode(values: Values, basedOnVersionId: string | null) {
  return createHash('sha256').update(canonical(values) + '|' + (basedOnVersionId ?? 'none')).digest('hex').slice(0, 8).toUpperCase();
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
      if (segment.length <= 120 && !/\d/.test(segment)) operations.push({ type: 'report_fact', field: item.field as 'display_name', value: segment, evidence });
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
  if (result.maintenance > 0 && baseline.maintenance === 0) factors.push(`תקבלי אחזקת רכב של ${shekels(result.maintenance)} ברוטו (חייבת במס)`);
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
  /** The turn advanced something else (e.g. a vehicle was selected), so a repeated question is not a failed ask. */
  progressed?: boolean;
};
export type FinancialOutcome = Pick<CatalogMessage, 'approval' | 'calculation' | 'actions'> & {
  text: string; offerRepresentative?: string;
};

const rulesMeta = z.object({ version: z.string().min(1).max(120), netMethod: z.object({ taxYear: z.number().int() }).passthrough() }).passthrough();

export async function advanceFinancialFlow(input: FinancialInput, deps: FinancialDependencies): Promise<FinancialOutcome> {
  const { state, latest, userId } = input;
  const say = (text: string, extra: Partial<FinancialOutcome> = {}): FinancialOutcome => ({ text: text.slice(0, 1600), ...extra });
  const stopAsking = () => { delete state.pendingField; delete state.pendingFieldAsks; };
  if (!input.occupation) {
    stopAsking();
    state.pendingQuestion = 'occupation';
    return say('כדי לחשב את הנטו אני צריכה לדעת מה התפקיד שלך בשטראוס. מה התפקיד שלך?');
  }
  let confirmed: EmployeeDataVersionRow | null;
  try { confirmed = await deps.confirmed(userId); }
  catch { return say('לא הצלחתי לטעון את הפרופיל שלך כרגע, אז אני לא יכולה לחשב. אפשר לנסות שוב עוד רגע?'); }
  if (confirmed && confirmed.user_id !== userId) throw new Error('Foreign employee profile');
  const proposal = buildProposal(confirmed, state, input.occupation);

  // 1. Missing values: exactly one question per turn, never a default value.
  const missing = proposal.missing.filter((field): field is FactField => field !== 'occupation_title');
  // Only clarifications the employee can act on: about a missing value, or a value they explicitly wrote.
  // A model misreading about an already-known value is dropped, so a confirmed value is never asked again.
  const notes = input.notes.filter(note => !note.field || missing.includes(note.field) || note.explicit);
  if (notes.length < input.notes.length) console.info('[carwise.ai.financial]', { droppedNotes: input.notes.length - notes.length });
  if (missing.length) {
    const unknown = missing.filter(field => state.unknownFacts?.includes(field));
    const next = nextQuestion(missing, unknown);
    const firstQuestion = !state.pendingField && !input.accepted && !notes.length;
    const parts: string[] = [];
    let offerRepresentative: string | undefined;
    const justUnknown = (input.unknownNow ?? []).filter(field => unknown.includes(field));
    if (justUnknown.length) {
      parts.push(`אין בעיה. בלי ${FIELDS[justUnknown[0]].about} אני לא יכולה לחשב נטו מדויק, ולא אנחש. אפשר לבדוק בתלוש השכר, או להיעזר בנציג.`);
      offerRepresentative = 'השלמת פרטי שכר לחישוב נטו';
    } else if (notes.length) parts.push(notes.map(note => note.text).join(' '));
    else if (input.accepted) parts.push(ACKS[state.revision % ACKS.length]);
    else if (firstQuestion) parts.push('כדי לחשב כמה זה ישפיע על הנטו שלך, נצטרך להשלים כמה פרטים.');
    // A clarification that already asks something is the single question of this turn.
    const clarifying = !justUnknown.length && notes.some(note => note.text.trim().endsWith('?'));
    if (!next) {
      stopAsking();
      state.pendingQuestion = 'financial';
      if (!justUnknown.length) parts.push(`כדי לחשב חסר לי רק ${unknown.map(field => FIELDS[field].about).join(' ו')}. אפשר לבדוק בתלוש השכר ולכתוב לי, או להיעזר בנציג.`);
      return { text: parts.join(' ').slice(0, 1600), offerRepresentative: 'השלמת פרטי שכר לחישוב נטו' };
    }
    state.pendingQuestion = 'financial';
    state.pendingFieldAsks = state.pendingField !== next ? 1 : (state.pendingFieldAsks ?? 1) + (input.progressed ? 0 : 1);
    state.pendingField = next;
    if (!clarifying) parts.push(justUnknown.length ? `בינתיים, ${FIELDS[next].ask}` : FIELDS[next].ask);
    // Avoid an endless loop on a value the employee cannot provide.
    if (state.pendingFieldAsks >= 3) { parts.push('אם קשה לברר את זה, נציג יכול לעזור.'); offerRepresentative = 'השלמת פרטי שכר לחישוב נטו'; }
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
  const code = proposalCode(proposal.values, confirmed?.id ?? null);
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
        : 'מעולה, יש לי את כל הפרטים! 🙌 הנה סיכום. אחרי שתאשרי, אשמור אותם בפרופיל ואחשב את הנטו.';
      // An allowance the employee wrote is never stored or added: the official one is used, and a difference is said.
      const stated = latest.body.match(/אחזקה[^\d]{0,12}(\d{1,3}(?:,\d{3})+|\d+)/u)?.[1];
      const official = input.occupation.waiver_allowed ? input.occupation.waiver_maintenance_amount : 0;
      const allowanceNote = stated && proposal.values.current_vehicle_id === null && Number(stated.replace(/,/g, '')) !== official
        ? `\nשימי לב: כתבת אחזקה של ${Number(stated.replace(/,/g, '')).toLocaleString('he-IL')} ₪, אבל בחישוב תילקח האחזקה לפי כללי החברה לתפקיד (${official.toLocaleString('he-IL')} ₪).` : '';
      return say(`${opening}\nהפרטים מבוססים על מה שמסרת, ולא נבדקו מול מערכת השכר. אם משהו לא נכון, כתבי לי מה לתקן.${allowanceNote}`, {
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
    state.pendingFacts = []; state.unknownFacts = []; delete state.pendingApproval;
  } else if (input.approvalCode) {
    delete state.pendingApproval;
  }
  if (!profile) throw new Error('Confirmed profile expected');
  state.confirmedVersion = { id: profile.id, version: profile.version };
  const savedText = approvedNow ? 'שמרתי את הפרטים ✓ ' : '';

  // 3. Which alternatives to calculate.
  const shown = state.shownVehicles ?? [];
  // A waiver question is answered on its own; earlier car results are repeated only when cars are named now.
  const waiverOnly = input.waiver && !input.vehiclesNamedNow;
  let selected = waiverOnly ? [] : state.selectedVehicleIds ?? [];
  if (!selected.length && !input.waiver) {
    if (shown.length && shown.length <= 3) selected = shown.map(vehicle => vehicle.id);
    else if (shown.length) {
      state.pendingQuestion = 'vehicle_selection';
      return say(`${savedText}לאילו רכבים לחשב את הנטו? אפשר לבחור אחד או כמה.`, {
        actions: [{ label: 'כל הרכבים שהוצגו', body: 'חישוב נטו לכל הרכבים שהוצגו', primary: true },
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
  catch { return say(`${savedText}כללי החישוב לא זמינים לי כרגע, אז אני לא יכולה לתת תוצאה מדויקת. אפשר לנסות שוב עוד מעט.`); }
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
      return say(`${savedText}${found && 'error' in found && found.error === 'tax_value_missing' ? 'לרכב שלך היום אין ערך שווי שימוש רשמי ברשימות המס' : 'הרכב שרשום לך היום לא מופיע בקטלוג הרכבים של החברה'}, אז אני לא יכולה לחשב את המצב הנוכחי ולהשוות אליו. נציג יכול לבדוק את פרטי הרכב.`, { offerRepresentative: 'בדיקת הרכב הנוכחי לחישוב' });
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
    state.selectedVehicleIds = [];
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
  const baselineView = scenarioView(baselineChoice.type === 'car' ? 'vehicle' : 'waiver', baselineCar, baselineName, baseline, true, baselineEligibility.reason, baseline.net);
  return say(`${savedText}הנה החישוב 👇\n${baselineChoice.type === 'waiver' ? 'היום, בלי רכב צמוד' : `היום, עם ${baselineName.replace('היום: ', '')}`}, הנטו שלך הוא בערך ${shekels(baseline.net)} בחודש.\n${lines.join('\n')}\n` +
    'החישוב לפי הפרטים שאישרת וכללי החברה. זו הערכה ולא תלוש שכר.' +
    (runId ? '' : ' (לא הצלחתי לשמור את החישוב בהיסטוריה.)'), {
    calculation: { runId, saved: Boolean(runId), profileVersion: profile.version, rulesVersion: meta.version, taxYear: meta.netMethod.taxYear,
      baseline: baselineView, scenarios: scenarios.map(item => item.view).slice(0, 6) },
    actions: input.state.occupation?.match?.waiver_allowed && !input.waiver && baselineChoice.type !== 'waiver'
      ? [{ label: 'מה אם אוותר על הרכב?', body: 'מה יקרה לנטו אם אוותר על רכב?' }] : undefined
  });
}
