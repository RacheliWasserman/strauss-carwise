import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '../supabase-server';
import { supabaseAdmin } from '../supabase-admin';
import { appendAssistantMessage, getConversation, listConversationMessages, type ConversationMessageRow } from '../conversation-repository';
import { advisorStateSchema } from './advisor-state';

export const turnStateSchema = z.object({
  stage: z.enum(['generating', 'ready', 'saving', 'complete', 'failed']),
  token: z.string().uuid(), attempts: z.number().int().min(1).max(3), startedAt: z.string().datetime(),
  reply: z.string().max(6000).optional(), replyId: z.string().uuid().optional(),
  businessState: advisorStateSchema.optional()
}).superRefine((state, context) => {
  if ((state.stage === 'ready' || state.stage === 'saving') && !state.reply) context.addIssue({ code: 'custom', message: 'Missing reserved reply' });
  if (state.stage === 'complete' && !state.replyId) context.addIssue({ code: 'custom', message: 'Missing saved reply ID' });
});
export type TurnState = z.infer<typeof turnStateSchema>;
export type TurnMessage = ConversationMessageRow & { metadata: Record<string, unknown> | null };
const columns = 'id, conversation_id, sender_type, sender_user_id, body, client_message_id, created_at';
function storageFailure(operation: string, error?: { code?: string } | null): never {
  const code = error?.code;
  console.warn('[carwise.ai.storage]', { operation, code: code && /^[A-Z0-9_]{1,20}$/.test(code) ? code : 'unknown' });
  throw new Error('AI storage unavailable');
}

export async function createTurnStore(userId: string, conversationId: string) {
  const client = await createSupabaseServerClient();
  return {
    conversation: () => getConversation(conversationId, userId, 'employee'),
    async source(id: string): Promise<TurnMessage | null> {
      const { data, error } = await client.from('advisor_conversation_messages').select(`${columns}, metadata`)
        .eq('conversation_id', conversationId).eq('id', id).eq('sender_type', 'employee').eq('sender_user_id', userId).maybeSingle();
      if (error) storageFailure('read_source', error);
      return data as TurnMessage | null;
    },
    history: () => listConversationMessages(conversationId, null, 60),
    async memory() {
      const {data,error}=await client.from('advisor_conversation_messages').select('metadata')
        .eq('conversation_id',conversationId).eq('sender_user_id',userId).eq('sender_type','employee')
        .eq('metadata->carwise_ai->>stage','complete')
        .not('metadata->carwise_ai->businessState','is',null)
        .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).maybeSingle();
      if (error) storageFailure('read_business_state',error);
      if (!data) return null;
      const state=advisorStateSchema.parse(data.metadata?.carwise_ai?.businessState);
      if (state.userId!==userId || state.conversationId!==conversationId) storageFailure('invalid_business_state_scope');
      return state;
    },
    async message(id: string): Promise<ConversationMessageRow | null> {
      const { data, error } = await client.from('advisor_conversation_messages').select(columns)
        .eq('conversation_id', conversationId).eq('id', id).eq('sender_type', 'assistant').maybeSingle();
      if (error) storageFailure('read_reply', error);
      return data as ConversationMessageRow | null;
    },
    async compareAndSet(source: TurnMessage, next: TurnState): Promise<boolean> {
      let query = supabaseAdmin.from('advisor_conversation_messages').update({ metadata: { ...source.metadata, carwise_ai: next } })
        .eq('id', source.id).eq('conversation_id', conversationId).eq('sender_type', 'employee').eq('sender_user_id', userId);
      query = source.metadata === null ? query.is('metadata', null) : query.eq('metadata', JSON.stringify(source.metadata));
      const { data, error } = await query.select('id').maybeSingle();
      if (error) storageFailure('reserve_turn', error);
      return Boolean(data);
    },
    async cooldown(now: number): Promise<boolean> {
      const { data: profile, error } = await client.from('advisor_employee_profiles').select('created_at, updated_at').eq('user_id', userId).maybeSingle();
      if (error || !profile) storageFailure('read_cooldown_profile', error);
      if (profile.updated_at !== profile.created_at && now - Date.parse(profile.updated_at) < 3000) return false;
      const { data, error: updateError } = await supabaseAdmin.from('advisor_employee_profiles').update({ updated_at: new Date(now).toISOString() })
        .eq('user_id', userId).eq('updated_at', profile.updated_at).select('user_id').maybeSingle();
      if (updateError) storageFailure('reserve_cooldown', updateError);
      return Boolean(data);
    },
    // This is the only assistant INSERT path. Metadata updates above never create messages.
    append: (body: string) => appendAssistantMessage(conversationId, userId, body),
    async reconcile(source: TurnMessage, reply: string): Promise<ConversationMessageRow | null> {
      const history = await listConversationMessages(conversationId, null, 100);
      const index = history.findIndex(message => message.id === source.id);
      if (index < 0) return null;
      const nextEmployee = history.findIndex((message, ordinal) => ordinal > index && message.sender_type === 'employee');
      const candidates = history.slice(index + 1, nextEmployee < 0 ? undefined : nextEmployee)
        .filter(message => message.sender_type === 'assistant' && message.body === reply);
      return candidates.length === 1 ? candidates[0] : null;
    }
  };
}
type Store = Awaited<ReturnType<typeof createTurnStore>>;
export type TurnStore = Omit<Store,'memory'> & Partial<Pick<Store,'memory'>>;
