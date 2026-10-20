
import { supabase } from '../../lib/supabase';
import { supabaseAdmin } from './supabase-admin';
import type { Car, Group } from './types';
import type { SupabaseClient } from '@supabase/supabase-js';

export type VehicleRow = {
  id: string;
  group_code: string;
  display_name: string;
  manufacturer_name: string;
  tax_year: number;
  registration_year: number;
  vehicle_type_code: string;
  manufacturer_code: string;
  model_code: string;
  drive_type: string;
  monthly_company_cost: number;
  default_employee_participation: number;
  model_description: string;
  list_price: number;
  active: boolean;
};

function activeVehicleQuery<Columns extends string>(client: SupabaseClient, columns: Columns) {
  return client
    .from('vehicle_catalog')
    .select(columns)
    .eq('active', true)
    .order('id');
}

export async function getVehicles(): Promise<VehicleRow[]> {
  const { data, error } = await activeVehicleQuery(supabase, '*');

  if (error) {
    throw new Error(`Failed to load vehicles: ${error.message}`);
  }

  return (data ?? []) as VehicleRow[];
}

export type VehicleSearchFilters = {
  name?: string; manufacturer?: string; group?: string; driveType?: string;
  limit: number; afterId?: string;
};
// Escape SQL LIKE metacharacters: search text is always literal, never a pattern.
const containsLiteral = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export async function searchVehicles(
  client: SupabaseClient, filters: VehicleSearchFilters
): Promise<unknown[]> {
  // Caller supplies the authenticated SSR client. Never fall back to admin/anon.
  let query = activeVehicleQuery(client,
    'id, display_name, manufacturer_name, group_code, drive_type, active');
  if (filters.name) query = query.ilike('display_name', containsLiteral(filters.name));
  if (filters.manufacturer) query = query.ilike('manufacturer_name', containsLiteral(filters.manufacturer));
  if (filters.group) query = query.eq('group_code', filters.group);
  if (filters.driveType) query = query.eq('drive_type', filters.driveType);
  if (filters.afterId) query = query.gt('id', filters.afterId);
  const { data, error } = await query.limit(filters.limit + 1);
  if (error || !Array.isArray(data)) throw new Error('Vehicle catalog unavailable');
  return data;
}


const calculatorVehicleColumns =
  'id, group_code, display_name, manufacturer_name, tax_year, registration_year, vehicle_type_code, manufacturer_code, model_code, drive_type, monthly_company_cost, default_employee_participation, model_description, list_price, active';

/** Full active rows for calculation, through the caller's authenticated client. Missing IDs are simply absent. */
export async function getActiveVehicleRowsByIds(
  client: SupabaseClient, ids: string[]
): Promise<VehicleRow[]> {
  if (!ids.length) return [];
  const { data, error } = await activeVehicleQuery(client, calculatorVehicleColumns).in('id', ids).limit(ids.length);
  if (error || !Array.isArray(data)) throw new Error('Vehicle catalog unavailable');
  return data as unknown as VehicleRow[];
}

export async function toCalculatorCar(
  vehicle: VehicleRow
): Promise<Car> {
  const officialValue =
    await getOfficialVehicleTaxValue(vehicle);

  return {
    'מזהה': vehicle.id,
    'קבוצה': vehicle.group_code as Group | 'משפחתי',
    'תוצר': vehicle.manufacturer_name,
    'קוד תוצר': vehicle.manufacturer_code,
    'דגם (כינוי מסחרי)': vehicle.display_name,
    'קוד דגם': vehicle.model_code,
    'תאור דגם': vehicle.model_description,
    'שנת רישום': vehicle.registration_year,
    'הנעה': vehicle.drive_type,
    'מחיר מחירון': vehicle.list_price,
    'שווי שימוש חודשי': officialValue,
    'עלות חודשית לחברה (דמה)': vehicle.monthly_company_cost,
    'השתתפות עובד ברירת מחדל (דמה)': vehicle.default_employee_participation,
  };
}



export async function getOfficialVehicleTaxValue(
  vehicle: VehicleRow
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('vehicle_tax_values')
    .select('monthly_value_of_use')
    .eq('tax_year', vehicle.tax_year)
    .eq('registration_year', vehicle.registration_year)
    .eq('vehicle_type_code', vehicle.vehicle_type_code)
    .eq('manufacturer_code', vehicle.manufacturer_code)
    .eq('model_code', vehicle.model_code)
    .limit(2);

  if (error) {
    throw new Error(
      `Failed to load tax value for ${vehicle.id}: ${error.message}`
    );
  }

  if (!data || data.length !== 1) {
    throw new Error(
      `Expected one tax record for ${vehicle.id}, found ${data?.length ?? 0}`
    );
  }

  const value = Number(data[0].monthly_value_of_use);

  if (!Number.isFinite(value)) {
    throw new Error(`Invalid tax value for ${vehicle.id}`);
  }

  return value;
}


