import 'server-only';
import { randomUUID } from 'node:crypto';
import {ZodError} from 'zod';
import { AI_LIMITS } from './config';
import { buildContext } from './context';
import { configuredProviders, generateReply, ProviderFailure } from './providers';
import { createTurnStore, turnStateSchema, type TurnMessage, type TurnState, type TurnStore } from './turn-store';
import type { AuthenticatedProfile } from '../require-authenticated-user';
import type { ConversationMessageRow } from '../conversation-repository';
import { runAdvisorTurn } from './advisor-orchestrator';
import { describeTurnError } from './turn-diagnostics';

export class AssistantError extends Error {
  constructor(public status: number, public code: string) { super('Assistant request failed'); }
}
type Result = { status: 'complete'; message: ConversationMessageRow } | { status: 'pending' };
const usage = new Map<string, { start: number; count: number }>();
function rateLimit(userId: string, now: number) {
  for (const [id, bucket] of usage) if (now - bucket.start >= 60000) usage.delete(id);
  const bucket = usage.get(userId);
  if (bucket && bucket.count >= AI_LIMITS.requestsPerMinute) throw new AssistantError(429, 'AI_RATE_LIMIT');
  if (!bucket && usage.size >= 4096) throw new AssistantError(429, 'AI_RATE_LIMIT');
  usage.set(userId, { start: bucket?.start ?? now, count: (bucket?.count ?? 0) + 1 });
}

export async function runAssistantTurn(
  profile: AuthenticatedProfile, conversationId: string, messageId: string,
  dependencies?: { store?: TurnStore; generate?: typeof generateReply; now?: () => number; statusOnly?: boolean }
): Promise<Result> {
  if (profile.role !== 'employee') throw new AssistantError(403, 'AI_FORBIDDEN');
  const store:TurnStore = dependencies?.store ?? await createTurnStore(profile.userId, conversationId);
  const conversation = await store.conversation();
  if (!conversation || conversation.owner_user_id !== profile.userId) throw new AssistantError(404, 'AI_NOT_FOUND');
  let source = await store.source(messageId);
  if (!source || source.id !== messageId || source.sender_user_id !== profile.userId || source.conversation_id !== conversationId || source.sender_type !== 'employee') throw new AssistantError(404, 'AI_NOT_FOUND');
  let state: TurnState | undefined;
  if (source.metadata?.carwise_ai !== undefined) {
    const parsed = turnStateSchema.safeParse(source.metadata.carwise_ai);
    if (!parsed.success) throw new AssistantError(409, 'AI_STATE_INVALID');
    state = parsed.data;
  }
  if (state?.stage === 'complete' && state.replyId) {
    const message = await store.message(state.replyId);
    if (!message) throw new AssistantError(503, 'AI_SAVE_UNCERTAIN');
    return { status: 'complete', message };
  }
  if (state?.stage === 'saving') {
    const message = state.reply ? await store.reconcile(source, state.reply) : null;
    if (!message) throw new AssistantError(503, 'AI_SAVE_UNCERTAIN');
    await store.compareAndSet(source, { ...state, stage: 'complete', replyId: message.id, reply: undefined });
    return { status: 'complete', message };
  }
  const now = dependencies?.now?.() ?? Date.now();
  if (state?.stage === 'generating' && now - Date.parse(state.startedAt) < AI_LIMITS.leaseMs) return { status: 'pending' };

  const fetched = await store.history();
  const history = fetched.filter(message => message.conversation_id === conversationId);
  if (history.filter(message => message.sender_type === 'employee').at(-1)?.id !== source.id) throw new AssistantError(409, 'AI_TURN_OUTDATED');
  const sourceIndex = history.findIndex(message => message.id === source!.id);
  if (sourceIndex < 0) throw new AssistantError(409, 'AI_TURN_OUTDATED');

  const transition = async (next: TurnState) => {
    if (!await store.compareAndSet(source!, next)) throw new AssistantError(409, 'AI_IN_PROGRESS');
    source = { ...source!, metadata: { ...source!.metadata, carwise_ai: next } };
    state = next;
  };

  if (state?.stage !== 'ready') {
    if (dependencies?.statusOnly) {
      if (state?.stage === 'failed') throw new AssistantError(503, 'AI_UNAVAILABLE');
      return { status: 'pending' };
    }
    if (!dependencies?.generate && configuredProviders().length === 0) throw new AssistantError(503, 'AI_NOT_CONFIGURED');
    if ((state?.attempts ?? 0) >= AI_LIMITS.maxTurnAttempts) throw new AssistantError(429, 'AI_TURN_LIMIT');
    rateLimit(profile.userId, now);
    if (!await store.cooldown(now)) throw new AssistantError(429, 'AI_RATE_LIMIT');
    await transition({ stage: 'generating', token: randomUUID(), attempts: (state?.attempts ?? 0) + 1, startedAt: new Date(now).toISOString() });
    const started=Date.now();
    let phase='context';
    try {
      const selected = history.slice(0, sourceIndex + 1);
      const context = buildContext(selected);
      console.info('[carwise.ai.history]', { fetchedCount: fetched.length, scopedCount: history.length,
        discardedForeignCount: fetched.length - history.length, selectedCount: selected.length,
        duplicateIdCount: selected.length - new Set(selected.map(message => message.id)).size,
        emptyBodyCount: selected.filter(message => !message.body.trim()).length,
        contextCount: context.length, sourceIncludedAsLastUser: context.at(-1)?.role === 'user' });
      if (dependencies?.generate) {
        phase='generation';
        await transition({...state!,stage:'ready',reply:await dependencies.generate(context)});
      } else {
        phase='memory';
        const memory=await store.memory?.()??null;
        phase='orchestration';
        const result=await runAdvisorTurn(profile.userId,conversationId,selected,memory);
        phase='reserve_reply';
        await transition({...state!,stage:'ready',reply:result.body,businessState:result.state});
      }
    } catch (error) {
      console.warn('[carwise.ai.turn]',{phase,durationMs:Math.max(0,Date.now()-started),
        kind:error instanceof ProviderFailure?'provider_failure':error instanceof ZodError?'invalid_local_data':error instanceof AssistantError?'coordination_failure':'local_failure',
        ...describeTurnError(error)});
      if (error instanceof AssistantError) throw error;
      await transition({ ...state!, stage: 'failed', reply: undefined });
      throw new AssistantError(503, error instanceof ProviderFailure && !error.retryable ? 'AI_REJECTED' : 'AI_UNAVAILABLE');
    }
  }

  if (!state?.reply) throw new AssistantError(503, 'AI_UNAVAILABLE');
  // Durable at-most-once append reservation. Never automatically repeat an uncertain RPC.
  const reply = state.reply;
  await transition({ ...state, stage: 'saving' });
  let replyId: string;
  try { replyId = await store.append(reply); }
  catch { throw new AssistantError(503, 'AI_SAVE_UNCERTAIN'); }
  await transition({ ...state!, stage: 'complete', replyId, reply: undefined });
  const message = await store.message(replyId);
  if (!message) throw new AssistantError(503, 'AI_SAVE_UNCERTAIN');
  return { status: 'complete', message };
}
