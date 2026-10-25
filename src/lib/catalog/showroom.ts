import { eligibility } from '../calculator';
import type { CatalogRow } from '../ai/vehicle-selection';
import type { CalculationRules } from '../rules-repository';
import type { Group } from '../types';

/**
 * The vehicle catalog page ("showroom"): labels, filters and personal eligibility for the company's active catalog.
 * Vehicles always come from the catalog itself; eligibility always comes from the calculator's own rule with the
 * employee's confirmed profile. Nothing here invents a vehicle, a specification or a financial value.
 */
export type ShowroomVehicle = CatalogRow;
export type EligibilityStatus = 'eligible' | 'ineligible' | 'unknown';
export type ShowroomEligibility = { status: EligibilityStatus; reason: string };
/** What eligibility is based on: the confirmed profile's occupation group and eligible children, or why it is unknown. */
export type EligibilityBasis =
  | { kind: 'confirmed'; occupation: string; group: Group; children: number }
  | { kind: 'unknown'; reason: string };

export const FAMILY_GROUP = 'משפחתי';
export const GROUP_ORDER = ['א', 'ב', 'ג', 'ד', FAMILY_GROUP] as const;
export const groupLabel = (group: string) => group === FAMILY_GROUP ? 'מסלול משפחתי' : `קבוצה ${group}`;

/** Propulsion as the catalog writes it (Hebrew), with a short badge and the tile wording. Unknown values pass through. */
const PROPULSION: Record<string, { badge: string; tile: string; icon: 'zap' | 'leaf' | 'plug' | 'fuel' }> = {
  'חשמלי': { badge: '100% חשמלי', tile: 'חשמלי', icon: 'zap' },
  'היברידי': { badge: 'היברידי', tile: 'היברידי', icon: 'leaf' },
  'פלאג-אין': { badge: 'פלאג־אין היברידי', tile: 'פלאג־אין', icon: 'plug' },
  'בנזין': { badge: 'בנזין', tile: 'בנזין', icon: 'fuel' }
};
export const propulsion = (driveType: string) => PROPULSION[driveType] ?? { badge: driveType, tile: driveType, icon: 'fuel' as const };

const ELIGIBLE_TEXT = 'כלול בזכאות שלך';
const INELIGIBLE_TEXT = 'לא כלול בזכאות שלך';
const UNKNOWN_TEXT = 'נדרשים פרטים לבדיקת זכאות';
export const eligibilityLabel = (status: EligibilityStatus) => status === 'eligible' ? ELIGIBLE_TEXT : status === 'ineligible' ? INELIGIBLE_TEXT : UNKNOWN_TEXT;

/**
 * Personal eligibility for one catalog vehicle, by the calculator's own rule (own group or lower; the family track
 * needs the minimum number of eligible children and a car on the official family list). Without a confirmed profile
 * (or rules) the answer is "unknown", never a guess.
 */
export function vehicleEligibility(vehicle: ShowroomVehicle, basis: EligibilityBasis,
  rules: Pick<CalculationRules, 'familyTrack' | 'budgets' | 'groupOrder'> | null): ShowroomEligibility {
  if (basis.kind === 'unknown' || !rules) return { status: 'unknown', reason: basis.kind === 'unknown' ? basis.reason : 'כללי הזכאות לא זמינים כרגע.' };
  if (vehicle.group_code !== FAMILY_GROUP && !rules.groupOrder.includes(vehicle.group_code)) return { status: 'unknown', reason: 'קבוצת הרכב לא מוכרת בכללי החברה.' };
  // The monthly company cost only affects the family-track employee share, never whether a car is allowed.
  const result = eligibility({ 'ילדים עד 23': basis.children },
    { type: 'car', car: { 'מזהה': vehicle.id, 'קבוצה': vehicle.group_code as Group | 'משפחתי', 'עלות חודשית לחברה (דמה)': 0 } },
    rules, { 'קבוצת זכאות': basis.group, 'מותר לוותר': 'לא' });
  return { status: result.eligible ? 'eligible' : 'ineligible', reason: result.reason };
}

export type ShowroomFilters = { query: string; group: string; propulsion: string; eligibleOnly: boolean };
export const EMPTY_FILTERS: ShowroomFilters = { query: '', group: 'all', propulsion: 'all', eligibleOnly: false };
export const filtersActive = (filters: ShowroomFilters) => filters.query.trim() !== '' || filters.group !== 'all' || filters.propulsion !== 'all' || filters.eligibleOnly;

/** Group and propulsion options actually present in the catalog, in a stable order. */
export function filterOptions(vehicles: ShowroomVehicle[]) {
  const groups = GROUP_ORDER.filter(group => vehicles.some(vehicle => vehicle.group_code === group));
  const known = Object.keys(PROPULSION);
  const present = [...new Set(vehicles.map(vehicle => vehicle.drive_type))];
  const propulsions = [...known.filter(value => present.includes(value)), ...present.filter(value => !known.includes(value)).sort()];
  return { groups, propulsions };
}

const fold = (text: string) => text.normalize('NFC').toLocaleLowerCase().replace(/[׳״'"`’‘.\-]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * Free text over the catalog name and manufacturer, plus Hebrew spellings of the model (e.g. "טוסון", "מודל 3").
 * Every query word must start a word of the vehicle ("קיה" finds Kia, not "טויוטה טורקיה").
 */
export function matchesQuery(vehicle: ShowroomVehicle, query: string, aliases: readonly string[] = []) {
  const wanted = fold(query);
  if (!wanted) return true;
  const words = fold([vehicle.display_name, vehicle.manufacturer_name, vehicle.id, groupLabel(vehicle.group_code), vehicle.drive_type, ...aliases].join(' ')).split(' ');
  return wanted.split(' ').every(part => words.some(word => word.startsWith(part)));
}

export function filterVehicles(vehicles: ShowroomVehicle[], filters: ShowroomFilters,
  eligibilityOf: (id: string) => ShowroomEligibility, aliasesOf: (vehicle: ShowroomVehicle) => readonly string[] = () => []) {
  return vehicles.filter(vehicle =>
    (filters.group === 'all' || vehicle.group_code === filters.group) &&
    (filters.propulsion === 'all' || vehicle.drive_type === filters.propulsion) &&
    (!filters.eligibleOnly || eligibilityOf(vehicle.id).status === 'eligible') &&
    matchesQuery(vehicle, filters.query, aliasesOf(vehicle)));
}

/** The chat link that opens the existing conversation flow for one catalog vehicle (its exact catalog ID only). */
export const netImpactHref = (vehicleId: string) => `/employee?${new URLSearchParams({ vehicle: vehicleId })}`;
/** The chat link from inside a flow (e.g. Match → "approve the details in the chat"): continues the conversation the
 * employee was in, with its unapproved summary, instead of opening a new one. */
export const CONTINUE_CHAT_HREF = '/employee?continue=1';
