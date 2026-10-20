import 'server-only';

import { createSupabaseServerClient } from './supabase-server';
import type { z } from 'zod';
import { employeeDataInputSchema } from './persistence-validation';

export type EmployeeDataInput = z.infer<typeof employeeDataInputSchema>;

export type EmployeeDataVersionRow = EmployeeDataInput & {
  id: string;
  user_id: string;
  version: number;
  status: 'draft' | 'confirmed';
  schema_version: string;
  created_at: string;
  confirmed_at: string | null;
};

const EMPLOYEE_DATA_SCHEMA_VERSION = 'employee-data-v1';
const employeeDataColumns =
  'id, user_id, version, status, schema_version, display_name, occupation_title, base_salary, commissions, bonus, employee_pension_percent, employee_study_fund_percent, tax_credit_points, eligible_children_count, current_vehicle_id, current_participation, created_at, confirmed_at';

export async function createEmployeeDataVersion(
  userId: string,
  input: EmployeeDataInput
): Promise<EmployeeDataVersionRow> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_employee_data_versions')
    .insert({
      user_id: userId,
      schema_version: EMPLOYEE_DATA_SCHEMA_VERSION,
      ...input
    })
    .select(employeeDataColumns)
    .single();

  if (error || !data) throw new Error('Failed to save employee data draft');
  return data as EmployeeDataVersionRow;
}

export async function getLatestConfirmedEmployeeData(
  userId: string
): Promise<EmployeeDataVersionRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_employee_data_versions')
    .select(employeeDataColumns)
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error('Failed to load confirmed employee data');
  return data as EmployeeDataVersionRow | null;
}

export async function listEmployeeDataVersions(
  userId: string
): Promise<EmployeeDataVersionRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_employee_data_versions')
    .select(employeeDataColumns)
    .eq('user_id', userId)
    .order('version', { ascending: false })
    .limit(50);

  if (error) throw new Error('Failed to list employee data versions');
  return (data ?? []) as EmployeeDataVersionRow[];
}

export async function confirmEmployeeDataVersion(
  userId: string,
  versionId: string
): Promise<EmployeeDataVersionRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data: confirmedId, error } = await supabase.rpc(
    'advisor_confirm_employee_data_version',
    { p_version_id: versionId }
  );

  if (error || typeof confirmedId !== 'string') {
    return null;
  }

  const { data, error: readError } = await supabase
    .from('advisor_employee_data_versions')
    .select(employeeDataColumns)
    .eq('id', confirmedId)
    .eq('user_id', userId)
    .maybeSingle();

  if (readError) throw new Error('Failed to read confirmed employee data version');
  return data as EmployeeDataVersionRow | null;
}
