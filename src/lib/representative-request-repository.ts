import 'server-only';

import { createSupabaseServerClient } from './supabase-server';

export type RepresentativeRequestRow = {
  id: string;
  conversation_id: string;
  owner_user_id: string;
  status: 'open' | 'claimed' | 'answered' | 'closed' | 'cancelled';
  topic: string | null;
  assigned_representative_id: string | null;
  requested_at: string;
  claimed_at: string | null;
  answered_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function createRepresentativeRequest(
  conversationId: string,
  ownerUserId: string,
  topic: string | null
): Promise<RepresentativeRequestRow> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_representative_requests')
    .insert({
      conversation_id: conversationId,
      owner_user_id: ownerUserId,
      topic
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('An active representative request already exists');
    }
    throw new Error('Failed to create representative request');
  }
  return data as RepresentativeRequestRow;
}

export async function listRepresentativeQueue(): Promise<RepresentativeRequestRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_representative_requests')
    .select('*')
    .in('status', ['open', 'claimed', 'answered'])
    .order('requested_at', { ascending: true })
    .limit(100);

  if (error) throw new Error('Failed to load representative queue');
  return (data ?? []) as RepresentativeRequestRow[];
}

export async function claimRepresentativeRequest(
  requestId: string
): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    'advisor_claim_representative_request',
    { p_request_id: requestId }
  );

  if (error || typeof data !== 'string') {
    throw new Error('Request is unavailable or already claimed');
  }
  return data;
}
