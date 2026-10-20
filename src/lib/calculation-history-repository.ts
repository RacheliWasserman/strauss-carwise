import 'server-only';

import { createSupabaseServerClient } from './supabase-server';
import { getAuthenticatedProfile } from './require-authenticated-user';
import { supabaseAdmin } from './supabase-admin';
import { ownsConversation } from './persistence-validation';

export type CalculationRunRow = {
  id: string;
  conversation_id: string;
  owner_user_id: string;
  employee_data_version_id: string;
  calculator_version: string;
  rules_version: string;
  tax_year: number;
  input_snapshot: Record<string, unknown>;
  baseline_snapshot: Record<string, unknown> | null;
  created_at: string;
};

export type CalculationScenarioRow = {
  id: string;
  run_id: string;
  owner_user_id: string;
  ordinal: number;
  choice_type: 'vehicle' | 'waiver';
  vehicle_id: string | null;
  vehicle_snapshot: Record<string, unknown> | null;
  eligible: boolean;
  result_snapshot: Record<string, unknown>;
  net_delta: number | null;
  created_at: string;
};

export type CalculationSnapshotInput = {
  conversationId: string;
  employeeDataVersionId: string;
  calculatorVersion: string;
  rulesVersion: string;
  taxYear: number;
  inputSnapshot: Record<string, unknown>;
  baselineSnapshot?: Record<string, unknown> | null;
  scenarios: Array<{
    ordinal: number;
    choiceType: 'vehicle' | 'waiver';
    vehicleId?: string | null;
    vehicleSnapshot?: Record<string, unknown> | null;
    eligible: boolean;
    resultSnapshot: Record<string, unknown>;
    netDelta?: number | null;
  }>;
};

export async function createCalculationSnapshot(
  input: CalculationSnapshotInput
): Promise<string> {
  const profile = await getAuthenticatedProfile();
  if (!profile || profile.role !== 'employee') {
    throw new Error('Employee authentication required');
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: conversation, error: conversationError }, { data: version, error: versionError }] =
    await Promise.all([
      supabase
        .from('advisor_conversations')
        .select('owner_user_id')
        .eq('id', input.conversationId)
        .maybeSingle(),
      supabase
        .from('advisor_employee_data_versions')
        .select('id')
        .eq('id', input.employeeDataVersionId)
        .eq('user_id', profile.userId)
        .eq('status', 'confirmed')
        .maybeSingle()
    ]);

  if (
    conversationError ||
    versionError ||
    !conversation ||
    !version ||
    !ownsConversation(conversation.owner_user_id, profile.userId, profile.role)
  ) {
    throw new Error('Conversation or confirmed employee version not accessible');
  }

  const { data, error } = await supabaseAdmin.rpc(
    'advisor_create_calculation_snapshot',
    {
      p_run: {
        conversation_id: input.conversationId,
        owner_user_id: profile.userId,
        employee_data_version_id: input.employeeDataVersionId,
        calculator_version: input.calculatorVersion,
        rules_version: input.rulesVersion,
        tax_year: input.taxYear,
        input_snapshot: input.inputSnapshot,
        baseline_snapshot: input.baselineSnapshot ?? null
      },
      p_scenarios: input.scenarios.map(scenario => ({
        ordinal: scenario.ordinal,
        choice_type: scenario.choiceType,
        vehicle_id: scenario.vehicleId ?? null,
        vehicle_snapshot: scenario.vehicleSnapshot ?? null,
        eligible: scenario.eligible,
        result_snapshot: scenario.resultSnapshot,
        net_delta: scenario.netDelta ?? null
      }))
    }
  );

  if (error || typeof data !== 'string') {
    throw new Error('Failed to persist calculation snapshot');
  }
  return data;
}

export async function listCalculationHistory(
  ownerUserId: string,
  conversationId?: string
): Promise<CalculationRunRow[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('advisor_calculation_runs')
    .select('id, conversation_id, owner_user_id, employee_data_version_id, calculator_version, rules_version, tax_year, input_snapshot, baseline_snapshot, created_at')
    .eq('owner_user_id', ownerUserId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (conversationId) query = query.eq('conversation_id', conversationId);

  const { data, error } = await query;
  if (error) throw new Error('Failed to load calculation history');
  return (data ?? []) as CalculationRunRow[];
}

export async function listCalculationScenarios(
  runId: string,
  ownerUserId: string
): Promise<CalculationScenarioRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_calculation_scenarios')
    .select('id, run_id, owner_user_id, ordinal, choice_type, vehicle_id, vehicle_snapshot, eligible, result_snapshot, net_delta, created_at')
    .eq('run_id', runId)
    .eq('owner_user_id', ownerUserId)
    .order('ordinal', { ascending: true });

  if (error) throw new Error('Failed to load calculation scenarios');
  return (data ?? []) as CalculationScenarioRow[];
}
