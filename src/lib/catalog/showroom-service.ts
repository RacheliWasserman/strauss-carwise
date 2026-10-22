import 'server-only';
import { searchAdvisorVehicles } from '../advisor-catalog-service';
import { activeCatalog } from '../ai/vehicle-selection';
import { getLatestConfirmedEmployeeData } from '../employee-data-repository';
import { listAdvisorOccupations } from '../occupation-repository';
import { getCalculationRules } from '../rules-repository';
import { vehicleEligibility, type EligibilityBasis, type ShowroomEligibility, type ShowroomVehicle } from './showroom';

export type Showroom =
  | { status: 'ready'; vehicles: ShowroomVehicle[]; eligibility: Record<string, ShowroomEligibility>; basis: EligibilityBasis }
  | { status: 'unavailable' };

/**
 * The active company catalog for the signed-in employee, read with their own authenticated client (RLS) through the
 * existing validated catalog service, plus personal eligibility from their latest CONFIRMED profile only: its
 * occupation's official group and its eligible-children count. A draft or chat-only value never decides eligibility.
 */
export async function loadShowroom(userId: string): Promise<Showroom> {
  let vehicles: ShowroomVehicle[];
  try { vehicles = await activeCatalog(searchAdvisorVehicles); }
  catch { return { status: 'unavailable' }; }
  const [basis, rules] = await Promise.all([eligibilityBasis(userId), getCalculationRules().catch(() => null)]);
  const eligibility = Object.fromEntries(vehicles.map(vehicle => [vehicle.id, vehicleEligibility(vehicle, basis, rules)]));
  return { status: 'ready', vehicles, eligibility, basis };
}

/**
 * A vehicle chosen on the catalog page, from the chat URL: only an exact ID of an ACTIVE catalog vehicle (read with the
 * employee's own client) is accepted; anything else is ignored, so a link can never start the flow for another car.
 */
export async function resolveVehicleIntent(value: string | string[] | undefined): Promise<{ id: string; display_name: string } | undefined> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) return undefined;
  try {
    const row = (await activeCatalog(searchAdvisorVehicles)).find(vehicle => vehicle.id === value);
    return row ? { id: row.id, display_name: row.display_name } : undefined;
  } catch { return undefined; }
}

async function eligibilityBasis(userId: string): Promise<EligibilityBasis> {
  try {
    const profile = await getLatestConfirmedEmployeeData(userId);
    if (!profile) return { kind: 'unknown', reason: 'עדיין אין פרופיל מאושר. אחרי שתאשרו את הפרטים בשיחה עם CarWise, הזכאות תוצג כאן.' };
    const occupation = (await listAdvisorOccupations()).find(item => item.title === profile.occupation_title);
    if (!occupation) return { kind: 'unknown', reason: 'התפקיד בפרופיל המאושר לא נמצא ברשימת התפקידים הרשמית, ולכן אי אפשר לקבוע זכאות.' };
    return { kind: 'confirmed', occupation: occupation.title, group: occupation.group_code, children: profile.eligible_children_count };
  } catch {
    return { kind: 'unknown', reason: 'לא הצלחתי לטעון כרגע את פרטי הזכאות שלך.' };
  }
}
