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

const requestColumns = 'id, conversation_id, owner_user_id, status, topic, assigned_representative_id, requested_at, claimed_at, answered_at, closed_at, created_at, updated_at';

/** Employee-scoped read (RLS: own requests only), used to verify a representative answer before it is offered. */
export async function getEmployeeRepresentativeRequest(
  requestId: string, conversationId: string, ownerUserId: string
): Promise<RepresentativeRequestRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('advisor_representative_requests').select(requestColumns)
    .eq('id', requestId).eq('conversation_id', conversationId).eq('owner_user_id', ownerUserId).maybeSingle();
  if (error) throw new Error('Failed to load representative request');
  return data as RepresentativeRequestRow | null;
}

/** The single active request of a conversation, if any (the schema allows one at a time). */
export async function findActiveRepresentativeRequest(
  conversationId: string, ownerUserId: string
): Promise<RepresentativeRequestRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('advisor_representative_requests').select(requestColumns)
    .eq('conversation_id', conversationId).eq('owner_user_id', ownerUserId)
    .in('status', ['open', 'claimed', 'answered']).limit(1).maybeSingle();
  if (error) throw new Error('Failed to load representative request');
  return data as RepresentativeRequestRow | null;
}

/** Representative-scoped read (RLS: open requests, or requests assigned to this representative). */
export async function getRequestForRepresentative(requestId: string): Promise<RepresentativeRequestRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('advisor_representative_requests').select(requestColumns).eq('id', requestId).maybeSingle();
  if (error) throw new Error('Failed to load representative request');
  return data as RepresentativeRequestRow | null;
}

/** This representative's OWN messages in the given conversations (bodies are parsed server-side, never returned raw). */
export async function listOwnRepresentativeMessages(
  representativeId: string, conversationIds: string[]
): Promise<Array<{ body: string; created_at: string }>> {
  if (!conversationIds.length) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('advisor_conversation_messages').select('body, created_at')
    .in('conversation_id', conversationIds).eq('sender_type', 'representative').eq('sender_user_id', representativeId)
    .order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error('Failed to load representative answers');
  return (data ?? []) as Array<{ body: string; created_at: string }>;
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

/**
 * Cancels the employee's OWN open/claimed/answered request (migration 202610210004), e.g. when they supplied the
 * requested field themselves. Returns false when it cannot be cancelled (or the function is not deployed yet);
 * the conversation then simply marks the request superseded and ignores a late answer.
 */
export async function cancelOwnRepresentativeRequest(requestId: string): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('advisor_cancel_own_representative_request', { p_request_id: requestId });
    return !error && data === true;
  } catch { return false; }
}
