import 'server-only';
import { calculateNet, displayShekels, eligibility, type Choice } from '../calculator';
import { toCalculatorEmployee, toCalculatorOccupation } from '../ai/financial-flow';
import { FAMILY_GROUP, vehicleEligibility, type ShowroomVehicle } from '../catalog/showroom';
import type { EmployeeDataVersionRow } from '../employee-data-repository';
import type { AdvisorOccupation } from '../occupation-repository';
import type { CalculationRules } from '../rules-repository';
import type { Car, Employee } from '../types';
import { MATCH_POWERTRAINS, type MatchCandidate, type MatchFinancial, type MatchPowertrain, type VehicleProfile } from './match-engine';
import { vehicleProfileFor } from './vehicle-profiles';

/** A catalog vehicle prepared for the calculator, with the tax year of its official value-of-use record. */
export type CalculatorVehicle = { car: Car; taxYear: number };
export type MatchDependencies = {
  confirmed: (userId: string) => Promise<EmployeeDataVersionRow | null>;
  occupations: () => Promise<AdvisorOccupation[]>;
  rules: () => Promise<CalculationRules>;
  catalog: () => Promise<ShowroomVehicle[]>;
  /** Active rows by exact ID with their official tax value; absent or null when the official record is missing. */
  vehicles: (ids: string[]) => Promise<Map<string, CalculatorVehicle | null>>;
  /** Supplemental model-level profile by exact ID (soft lifestyle signals only). */
  profile?: (id: string, registrationYear?: number) => VehicleProfile | undefined;
};
export type MatchContext =
  | { status: 'needs_profile'; reason: string }
  | { status: 'unavailable' }
  | { status: 'ready'; candidates: MatchCandidate[]; powertrains: MatchPowertrain[];
      basis: { occupation: string; group: string }; notes: string[]; rulesVersion: string };

const PROVISIONAL = 'האומדן מחושב במחשבון החברה לפי הפרופיל המאושר שלך וכללי החישוב, אבל הוא זמני: הוא אינו תלוש שכר ואינו סכום סופי.';
const PARTICIPATION = 'השתתפות העובד ברכב חלופי לקוחה מערך ברירת המחדל שבקטלוג (בנתוני האתגר מוגדר כנתון דמה), ולא מסכום שנקבע לך אישית.';
const FAMILY_COST = 'חלק העובד במסלול המשפחתי נגזר מהעלות החודשית לחברה שבקטלוג, שבנתוני האתגר מוגדרת כנתון דמה.';

async function defaultDependencies(): Promise<MatchDependencies> {
  const [employeeData, occupations, rules, catalog, selection, vehicles, server] = await Promise.all([
    import('../employee-data-repository'), import('../occupation-repository'), import('../rules-repository'),
    import('../advisor-catalog-service'), import('../ai/vehicle-selection'), import('../vehicle-repository'), import('../supabase-server')]);
  return {
    confirmed: userId => employeeData.getLatestConfirmedEmployeeData(userId),
    occupations: () => occupations.listAdvisorOccupations(),
    rules: () => rules.getCalculationRules(),
    // The employee's own authenticated client: catalog RLS applies.
    catalog: () => selection.activeCatalog(input => catalog.searchAdvisorVehicles(input)),
    async vehicles(ids) {
      const rows = await vehicles.getActiveVehicleRowsByIds(await server.createSupabaseServerClient(), ids);
      // The official lookup throws unless exactly one record exists; such a vehicle has no estimate (never a substitute).
      return new Map(await Promise.all(rows.map(async row => [row.id,
        await vehicles.toCalculatorCar(row).then(car => ({ car, taxYear: row.tax_year }), () => null)] as const)));
    }
  };
}

/**
 * Everything CarWise Match may rank, for the signed-in employee only: their latest CONFIRMED profile, its official
 * occupation group, the active catalog filtered by the calculator's own eligibility rule, and the calculator's
 * estimate against today. Nothing comes from the client, and nothing missing is replaced by a default.
 */
export async function loadMatchContext(userId: string, injected?: MatchDependencies): Promise<MatchContext> {
  const deps = injected ?? await defaultDependencies();
  let profile: EmployeeDataVersionRow | null;
  try { profile = await deps.confirmed(userId); } catch { return { status: 'unavailable' }; }
  if (!profile || profile.user_id !== userId || profile.status !== 'confirmed') {
    return { status: 'needs_profile', reason: 'כדי להתאים רכבים לפי הזכאות שלך צריך קודם פרופיל מאושר. אפשר להשלים ולאשר את הפרטים בשיחה עם CarWise.' };
  }
  let occupations: AdvisorOccupation[]; let rules: CalculationRules; let catalog: ShowroomVehicle[];
  try { [occupations, rules, catalog] = await Promise.all([deps.occupations(), deps.rules(), deps.catalog()]); }
  catch { return { status: 'unavailable' }; }
  const role = occupations.find(item => item.title === profile.occupation_title);
  if (!role) return { status: 'needs_profile', reason: 'התפקיד בפרופיל המאושר לא נמצא ברשימת התפקידים הרשמית, ולכן אי אפשר לקבוע זכאות. אפשר לברר זאת בשיחה עם CarWise.' };
  let employee: Employee;
  try { employee = toCalculatorEmployee(profile, role); }
  catch { return { status: 'needs_profile', reason: 'חסרים פרטים בפרופיל המאושר. אפשר להשלים אותם בשיחה עם CarWise.' }; }
  const occupation = toCalculatorOccupation(role);
  const basis = { kind: 'confirmed' as const, occupation: role.title, group: role.group_code, children: employee['ילדים עד 23'] };
  const eligible = catalog.flatMap(vehicle => {
    const result = vehicleEligibility(vehicle, basis, rules);
    return result.status === 'eligible' ? [{ vehicle, reason: result.reason }] : [];
  });

  // The calculator's estimate against today's situation (the confirmed current car, or no car).
  const baselineId = profile.current_vehicle_id ?? null;
  let lookup = new Map<string, CalculatorVehicle | null>();
  let unavailable: string | undefined;
  try { lookup = await deps.vehicles([...new Set([...(baselineId ? [baselineId] : []), ...eligible.map(item => item.vehicle.id)])]); }
  catch { unavailable = 'נתוני הקטלוג לחישוב לא זמינים כרגע.'; }
  let baselineNet: number | undefined;
  if (!unavailable) {
    let baseline: Choice = { type: 'waiver' };
    if (baselineId) {
      const today = lookup.get(baselineId);
      if (today) baseline = { type: 'car', car: today.car, participation: employee['השתתפות היום'] };
      else unavailable = 'לרכב שלך היום אין נתוני מס רשמיים זמינים, ולכן אין בסיס להשוואה.';
    }
    if (!unavailable && !eligibility(employee, baseline, rules, occupation).eligible) unavailable = 'המצב הרשום לך היום לא תואם לכללי החברה, ולכן אין בסיס בטוח להשוואה.';
    if (!unavailable) {
      try { baselineNet = displayShekels(calculateNet(employee, baseline, rules, occupation).net); }
      catch { unavailable = 'לא ניתן היה לחשב את המצב שלך היום.'; }
    }
  }
  const taxYears = new Set<number>();
  const candidates = eligible.map(({ vehicle, reason }): MatchCandidate => {
    let financial: MatchFinancial = { status: 'unavailable', reason: unavailable ?? 'חסר לרכב ערך שווי שימוש רשמי, ולכן לא חושב.' };
    const found = lookup.get(vehicle.id);
    if (!unavailable && found && baselineNet !== undefined) {
      try {
        const result = calculateNet(employee, { type: 'car', car: found.car }, rules, occupation);
        financial = { status: 'estimate', delta: displayShekels(result.net) - baselineNet,
          electricBonus: displayShekels(result.electricNetBonus), familyShare: displayShekels(result.familyExtra) };
        taxYears.add(found.taxYear);
      } catch { financial = { status: 'unavailable', reason: 'החישוב לרכב הזה לא הושלם.' }; }
    }
    // The catalog's registration year (when its calculator row was read) is authoritative; the profile only joins to it.
    const registrationYear = found?.car['שנת רישום'];
    return { id: vehicle.id, display_name: vehicle.display_name, manufacturer_name: vehicle.manufacturer_name,
      group_code: vehicle.group_code, drive_type: vehicle.drive_type, registration_year: registrationYear, eligibilityReason: reason,
      family: vehicle.group_code === FAMILY_GROUP, current: vehicle.id === baselineId, financial,
      profile: (deps.profile ?? vehicleProfileFor)(vehicle.id, registrationYear) };
  });

  const notes: string[] = [];
  if (candidates.some(candidate => candidate.financial.status === 'estimate')) {
    notes.push(PROVISIONAL, PARTICIPATION);
    const rulesYear = Number(rules.netMethod?.taxYear);
    const other = [...taxYears].filter(year => year !== rulesYear);
    if (other.length) notes.push(`מדרגות המס בכללי החישוב הן של שנת ${rulesYear}, ואילו שווי השימוש לקוח מקובץ רשות המסים לשנת ${other.join(', ')}. לכן זהו אומדן בלבד.`);
    if (candidates.some(candidate => candidate.family && candidate.financial.status === 'estimate')) notes.push(FAMILY_COST);
  }
  const present = new Set(candidates.filter(candidate => !candidate.current).map(candidate => candidate.drive_type));
  return { status: 'ready', candidates, powertrains: MATCH_POWERTRAINS.filter(value => present.has(value)),
    basis: { occupation: role.title, group: role.group_code }, notes, rulesVersion: String(rules.version ?? '') };
}
