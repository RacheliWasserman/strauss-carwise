
import 'server-only';
import { supabaseAdmin } from './supabase-admin';


export type CalculationRules = {
  version: string;
  groupOrder: string[];
  budgets: Record<'א' | 'ב' | 'ג' | 'ד', number>;
  familyTrack: {
    minChildren: number;
    cars: string[];
    gapSplitEmployee: number;
  };
  electric: {
    netBonus: number;
  };
  netMethod: {
    taxYear: number;
    brackets: (number | null)[][];
    creditPointValue: number;
    pensionCredit: {
      rate: number;
      maxContributionRate: number;
      incomeCeiling: number;
    };
    nationalInsurance: {
      threshold: number;
      ceiling: number;
      lowRate: number;
      highRate: number;
    };
    health: {
      threshold: number;
      ceiling: number;
      lowRate: number;
      highRate: number;
    };
  };
};


export async function getCalculationRules():
  Promise<CalculationRules> {

  const { data, error } = await supabaseAdmin
    .from('calculation_rules')
    .select('rules')
    .eq('active', true)
    .limit(2);

  if (error) {
    throw new Error(
      `Failed to load calculation rules: ${error.message}`
    );
  }

  if (!data || data.length !== 1) {
    throw new Error(
      'Expected exactly one active calculation rules record'
    );
  }

  return data[0].rules as CalculationRules;
}
