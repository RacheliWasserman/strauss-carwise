
import 'server-only';
import { supabaseAdmin } from './supabase-admin';
import type { Employee, Group ,Occupation } from './types';

export async function getDemoEmployee(code: string) {
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select(`
      *,
      occupations (
        title,
        group_code,
        car_mandatory,
        waiver_allowed,
        waiver_maintenance_amount
      )
    `)
    .eq('demo_employee_code', code)
    .eq('is_demo', true)
    .single();

  if (error) {
    throw new Error(
      `Failed to load demo employee: ${error.message}`
    );
  }

  return data;
}


export async function getCalculatorEmployee(
  code: string
): Promise<Employee> {
  const row = await getDemoEmployee(code);

  if (!row.occupations) {
    throw new Error('Employee occupation not found');
  }

  return {
    'מזהה': row.demo_employee_code,
    'שם': row.display_name,
    'ת״ז (פיקטיבית)': '',
    'עיסוק': row.occupations.title,
    'קבוצה': row.occupations.group_code as Group,
    'שכר בסיס': Number(row.base_salary),
    'עמלות': Number(row.commissions),
    'בונוס': Number(row.bonus),
    'פנסיה עובד %': Number(row.employee_pension_percent),
    'קרן השתלמות עובד %': Number(
      row.employee_study_fund_percent
    ),
    'נקודות זיכוי': Number(row.tax_credit_points),
    'ילדים עד 23': Number(row.eligible_children_count),
    currentVehicleId: row.current_vehicle_id ?? null,
    'השתתפות היום': Number(row.current_participation),
    'השאלה': '',
  };
}


export async function getCalculatorOccupation(
  code: string
): Promise<Occupation> {
  const row = await getDemoEmployee(code);

  if (!row.occupations) {
    throw new Error('Employee occupation not found');
  }

  const occupation = row.occupations;

  return {
    'עיסוק': occupation.title,
    'קבוצת זכאות': occupation.group_code as Group,
    'רכב חובה': occupation.car_mandatory ? 'כן' : 'לא',
    'מותר לוותר': occupation.waiver_allowed ? 'כן' : 'לא',
    'אחזקת רכב בוויתור (₪)': Number(
      occupation.waiver_maintenance_amount
    ),
  };
}
