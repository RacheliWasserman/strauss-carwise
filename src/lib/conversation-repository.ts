import 'server-only';

import { createSupabaseServerClient } from './supabase-server';
import {
  canPostEmployeeMessage,
  canPostRepresentativeReply,
  ownsConversation,
  messageCursorSchema,
  type MessageCursor
} from './persistence-validation';
import type { UserRole } from './auth-types';
import { supabaseAdmin } from './supabase-admin';
import { getAuthenticatedProfile } from './require-authenticated-user';

export type ConversationRow = {
  id: string;
  owner_user_id: string;
  title: string | null;
  status: 'open';
  created_at: string;
  updated_at: string;
  last_message_at: string;
};

export type ConversationMessageRow = {
  id: string;
  conversation_id: string;
  sender_type: 'employee' | 'assistant' | 'representative';
  sender_user_id: string | null;
  body: string;
  client_message_id: string | null;
  created_at: string;
};

export async function createConversationWithFirstMessage(
  body: string,
  clientRequestId?: string
) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    'advisor_create_conversation_with_first_message',
    { p_body: body, p_client_request_id: clientRequestId ?? null }
  );

  if (error?.code === '23505' && error.message.includes('Idempotency key reused')) {
    throw new Error('Idempotency key reused with different request');
  }
  if (error || typeof data !== 'string') {
    throw new Error('Failed to create conversation');
  }

  return data;
}

/**
 * The message of a conversation that holds exactly one message (a conversation just created), read through the
 * caller's own RLS session. Null otherwise (e.g. a retried creation of a conversation that has since continued) or
 * when it cannot be read; the caller then simply loads the thread as usual.
 */
export async function getSoleConversationMessage(
  conversationId: string
): Promise<ConversationMessageRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_conversation_messages')
    .select('id, conversation_id, sender_type, sender_user_id, body, client_message_id, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(2);
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  return data[0] as ConversationMessageRow;
}

export async function listConversations(
  ownerUserId: string,
  before: MessageCursor | null = null,
  limit = 100
): Promise<ConversationRow[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('advisor_conversations')
    .select('id, owner_user_id, title, status, created_at, updated_at, last_message_at')
    .eq('owner_user_id', ownerUserId)
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (before) {
    const cursor = messageCursorSchema.parse(before);
    query = query.or(
      `last_message_at.lt.${cursor.createdAt},and(last_message_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
    );
  }

  const { data, error } = await query;

  if (error) throw new Error('Failed to list conversations');
  return (data ?? []) as ConversationRow[];
}

export async function getConversation(
  conversationId: string,
  viewerUserId: string,
  viewerRole: UserRole
): Promise<ConversationRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('advisor_conversations')
    .select('id, owner_user_id, title, status, created_at, updated_at, last_message_at')
    .eq('id', conversationId)
    .maybeSingle();

  if (error || !data) return null;
  if (
    viewerRole === 'employee' &&
    !ownsConversation(data.owner_user_id, viewerUserId, viewerRole)
  ) {
    return null;
  }

  return data as ConversationRow;
}

export async function listConversationMessages(
  conversationId: string,
  before: MessageCursor | null,
  limit: number
): Promise<ConversationMessageRow[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('advisor_conversation_messages')
    .select('id, conversation_id, sender_type, sender_user_id, body, client_message_id, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (before) {
    const cursor = messageCursorSchema.parse(before);
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
    );
  }

  const { data, error } = await query;
  if (error) throw new Error('Failed to load conversation messages');
  return ((data ?? []) as ConversationMessageRow[]).reverse();
}

export async function sendConversationMessage(
  conversationId: string,
  viewerUserId: string,
  viewerRole: UserRole,
  body: string,
  clientMessageId?: string
): Promise<ConversationMessageRow> {
  const supabase = await createSupabaseServerClient();
  let senderType: 'employee' | 'representative';

  if (canPostEmployeeMessage(viewerRole)) {
    const conversation = await getConversation(
      conversationId,
      viewerUserId,
      viewerRole
    );
    if (!conversation) throw new Error('Conversation not found');
    senderType = 'employee';
  } else {
    const { data: request, error } = await supabase
      .from('advisor_representative_requests')
      .select('assigned_representative_id')
      .eq('conversation_id', conversationId)
      .eq('assigned_representative_id', viewerUserId)
      .in('status', ['claimed', 'answered'])
      .order('requested_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      error ||
      !request ||
      !canPostRepresentativeReply(
        viewerRole,
        request.assigned_representative_id,
        viewerUserId
      )
    ) {
      throw new Error('Conversation not assigned to representative');
    }
    senderType = 'representative';
  }

  const { data, error } = await supabase
    .from('advisor_conversation_messages')
    .insert({
      conversation_id: conversationId,
      sender_type: senderType,
      sender_user_id: viewerUserId,
      body,
      client_message_id: clientMessageId ?? null
    })
    .select('id, conversation_id, sender_type, sender_user_id, body, client_message_id, created_at')
    .single();

  if (error?.code === '23505' && clientMessageId) {
    const { data: existingMessage, error: lookupError } = await supabase
      .from('advisor_conversation_messages')
      .select('id, conversation_id, sender_type, sender_user_id, body, client_message_id, created_at')
      .eq('conversation_id', conversationId)
      .eq('client_message_id', clientMessageId)
      .maybeSingle();

    if (!lookupError && existingMessage) {
      if (
        existingMessage.sender_type === senderType &&
        existingMessage.sender_user_id === viewerUserId &&
        existingMessage.body === body
      ) {
        return existingMessage as ConversationMessageRow;
      }
      throw new Error('Idempotency key reused with different message');
    }
  }

  if (error || !data) throw new Error('Failed to send message');
  return data as ConversationMessageRow;
}

export async function appendAssistantMessage(
  conversationId: string,
  ownerUserId: string,
  body: string
): Promise<string> {
  // Both checks are read concurrently (the conversation read uses the caller's own RLS session) and still
  // enforced in order before the privileged append.
  const conversationRead = getConversation(
    conversationId,
    ownerUserId,
    'employee'
  );
  conversationRead.catch(() => {});
  const profile = await getAuthenticatedProfile();
  if (
    !profile ||
    profile.role !== 'employee' ||
    profile.userId !== ownerUserId
  ) {
    throw new Error('Employee authentication required');
  }

  const conversation = await conversationRead;
  if (!conversation) throw new Error('Conversation not found');

  const { data, error } = await supabaseAdmin.rpc(
    'advisor_append_assistant_message',
    {
      p_conversation_id: conversationId,
      p_owner_user_id: ownerUserId,
      p_body: body
    }
  );

  if (error || typeof data !== 'string') {
    throw new Error('Failed to save assistant message');
  }
  return data;
}
