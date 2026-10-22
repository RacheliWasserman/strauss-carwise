import 'server-only';
import type { EmployeeDataInput, EmployeeDataVersionRow } from '../employee-data-repository';
import type { AdvisorOccupation } from '../occupation-repository';
import type { CatalogRow } from '../ai/vehicle-selection';
import type { OwnIdentity } from '../identity/identity-repository';
import { PROFILE_NUMBER_ORDER, type ProfileSave, type ProfileSnapshot } from './profile-form';

/** The official occupation list as the profile form shows it (key = the application's reference, see occupation-repository). */
export type ProfileOccupation = Pick<AdvisorOccupation, 'key' | 'title' | 'group_code' | 'car_mandatory' | 'waiver_allowed'>;
export type ProfileVehicle = Pick<CatalogRow, 'id' | 'display_name' | 'manufacturer_name'>;
export type OwnProfile = {
  snapshot: ProfileSnapshot | null;
  /** Null when the list could not be loaded (the form then explains it and cannot be saved). */
  occupations: ProfileOccupation[] | null;
  vehicles: ProfileVehicle[] | null;
  /** The confirmed version could not be read: the form must not offer to overwrite a profile it cannot see. */
  profileUnavailable: boolean;
};

export type ProfileDependencies = {
  confirmed: (userId: string) => Promise<EmployeeDataVersionRow | null>;
  occupations: () => Promise<AdvisorOccupation[]>;
  vehicles: () => Promise<CatalogRow[]>;
  createVersion: (userId: string, input: EmployeeDataInput) => Promise<EmployeeDataVersionRow>;
  confirmVersion: (userId: string, versionId: string) => Promise<EmployeeDataVersionRow | null>;
};

export async function defaultProfileDependencies(): Promise<ProfileDependencies> {
  const [employeeData, occupations, catalog, selection] = await Promise.all([import('../employee-data-repository'),
    import('../occupation-repository'), import('../advisor-catalog-service'), import('../ai/vehicle-selection')]);
  return {
    confirmed: userId => employeeData.getLatestConfirmedEmployeeData(userId),
    occupations: () => occupations.listAdvisorOccupations(),
    vehicles: () => selection.activeCatalog(input => catalog.searchAdvisorVehicles(input)),
    createVersion: (userId, input) => employeeData.createEmployeeDataVersion(userId, input),
    confirmVersion: (userId, versionId) => employeeData.confirmEmployeeDataVersion(userId, versionId)
  };
}

const toOccupation = ({ key, title, group_code, car_mandatory, waiver_allowed }: AdvisorOccupation): ProfileOccupation =>
  ({ key, title, group_code, car_mandatory, waiver_allowed });
const toVehicle = ({ id, display_name, manufacturer_name }: CatalogRow): ProfileVehicle => ({ id, display_name, manufacturer_name });

export function toSnapshot(row: EmployeeDataVersionRow, occupations: AdvisorOccupation[] | null): ProfileSnapshot {
  const numbers = Object.fromEntries(PROFILE_NUMBER_ORDER.map(field => [field, Number(row[field])])) as Record<(typeof PROFILE_NUMBER_ORDER)[number], number>;
  return { ...numbers, versionId: row.id, version: row.version, confirmedAt: row.confirmed_at, displayName: row.display_name,
    occupationTitle: row.occupation_title, occupationKey: occupations?.find(item => item.title === row.occupation_title)?.key ?? null,
    current_vehicle_id: row.current_vehicle_id };
}

/**
 * Everything the profile page needs, read in parallel with the employee's own session (RLS: own rows only).
 * A list that fails to load is reported as unavailable, never replaced with local or invented data.
 */
export async function loadOwnProfile(userId: string, deps?: ProfileDependencies): Promise<OwnProfile> {
  const use = deps ?? await defaultProfileDependencies();
  const [confirmed, occupations, vehicles] = await Promise.allSettled([use.confirmed(userId), use.occupations(), use.vehicles()]);
  const official = occupations.status === 'fulfilled' ? occupations.value : null;
  const row = confirmed.status === 'fulfilled' && confirmed.value?.user_id === userId ? confirmed.value : null;
  return {
    snapshot: row ? toSnapshot(row, official) : null,
    occupations: official ? official.map(toOccupation) : null,
    vehicles: vehicles.status === 'fulfilled' ? vehicles.value.map(toVehicle) : null,
    profileUnavailable: confirmed.status === 'rejected'
  };
}

export type SaveOutcome =
  | { status: 'saved'; snapshot: ProfileSnapshot }
  | { status: 'unchanged'; snapshot: ProfileSnapshot }
  /** The approved profile changed since the form was opened (e.g. approved in the chat): nothing is overwritten. */
  | { status: 'stale'; snapshot: ProfileSnapshot | null }
  | { status: 'invalid_occupation' | 'invalid_vehicle' | 'name_required' | 'unavailable' | 'failed' };

const NUMBER_KEYS = PROFILE_NUMBER_ORDER;
function sameAsConfirmed(row: EmployeeDataVersionRow, input: EmployeeDataInput) {
  return row.display_name === input.display_name && row.occupation_title === input.occupation_title &&
    (row.current_vehicle_id ?? null) === input.current_vehicle_id && NUMBER_KEYS.every(key => Number(row[key]) === input[key]);
}

/**
 * Saves the employee's own profile as a new CONFIRMED version, through the same repository functions (and the same
 * RLS policies and database function) as an approval in the chat. The role is resolved from the official occupations
 * list by its key, the current car from the active catalog; the name is the account's stored name when there is one.
 * Nothing is written when the values equal the approved profile, and nothing is overwritten when it changed meanwhile.
 */
export async function saveOwnProfile(userId: string, input: ProfileSave, identity: OwnIdentity, deps?: ProfileDependencies): Promise<SaveOutcome> {
  const use = deps ?? await defaultProfileDependencies();
  let confirmed: EmployeeDataVersionRow | null, occupations: AdvisorOccupation[], vehicles: CatalogRow[] | null;
  try {
    [confirmed, occupations, vehicles] = await Promise.all([use.confirmed(userId), use.occupations(),
      input.current_vehicle_id === null ? Promise.resolve(null) : use.vehicles()]);
  } catch { return { status: 'unavailable' }; }
  if (confirmed && confirmed.user_id !== userId) return { status: 'failed' };
  if ((confirmed?.id ?? null) !== input.basedOnVersionId) return { status: 'stale', snapshot: confirmed ? toSnapshot(confirmed, occupations) : null };
  const occupation = occupations.find(item => item.key === input.occupationKey);
  if (!occupation) return { status: 'invalid_occupation' };
  if (input.current_vehicle_id !== null && !vehicles?.some(vehicle => vehicle.id === input.current_vehicle_id)) return { status: 'invalid_vehicle' };
  const accountName = identity.status === 'complete' ? `${identity.firstName} ${identity.lastName}`.trim() : null;
  const typedName = input.name ? `${input.name.firstName} ${input.name.lastName}`.trim() : null;
  const displayName = (accountName || typedName || '').slice(0, 120);
  if (!displayName) return { status: 'name_required' };
  const values: EmployeeDataInput = {
    display_name: displayName, occupation_title: occupation.title, base_salary: input.base_salary, commissions: input.commissions,
    bonus: input.bonus, employee_pension_percent: input.employee_pension_percent, employee_study_fund_percent: input.employee_study_fund_percent,
    tax_credit_points: input.tax_credit_points, eligible_children_count: input.eligible_children_count,
    current_vehicle_id: input.current_vehicle_id, current_participation: input.current_vehicle_id === null ? 0 : input.current_participation
  };
  if (confirmed && sameAsConfirmed(confirmed, values)) return { status: 'unchanged', snapshot: toSnapshot(confirmed, occupations) };
  try {
    const draft = await use.createVersion(userId, values);
    const saved = await use.confirmVersion(userId, draft.id);
    if (!saved || saved.user_id !== userId) return { status: 'failed' };
    return { status: 'saved', snapshot: toSnapshot(saved, occupations) };
  } catch { return { status: 'failed' }; }
}
