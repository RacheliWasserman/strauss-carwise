import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ userFrom: vi.fn(), adminFrom: vi.fn(), append: vi.fn(), history: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../src/lib/supabase-server', () => ({ createSupabaseServerClient: async () => ({ from: mocks.userFrom }) }));
vi.mock('../src/lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.adminFrom } }));
vi.mock('../src/lib/conversation-repository', () => ({
  appendAssistantMessage: mocks.append, getConversation: vi.fn(), listConversationMessages: mocks.history
}));
import { createTurnStore, type TurnMessage, type TurnState } from '../src/lib/ai/turn-store';
import {randomUUID} from 'node:crypto';

function builder(data: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const key of ['select', 'eq', 'is', 'update','not','order','limit']) query[key] = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return query;
}
beforeEach(() => vi.resetAllMocks());
it('logs only a storage operation and safe database code on coordination failure', async () => {
  const query = builder(null);
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: '42501', message: 'private salary token' } });
  mocks.adminFrom.mockReturnValue(query);
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect((await createTurnStore('owner', 'conversation')).compareAndSet(
    { id: 'message', metadata: null } as TurnMessage,
    { stage: 'generating', token: '11111111-1111-4111-8111-111111111111', attempts: 1, startedAt: new Date().toISOString() }
  )).rejects.toThrow('AI storage unavailable');
  expect(log).toHaveBeenCalledWith('[carwise.ai.storage]', { operation: 'reserve_turn', code: '42501' });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/salary|token|owner|conversation/);
  log.mockRestore();
});
it('reads only the authenticated employee message in the requested conversation', async () => {
  const query = builder(null); mocks.userFrom.mockReturnValue(query);
  await (await createTurnStore('owner', 'conversation')).source('message');
  expect(query.eq.mock.calls).toEqual([
    ['conversation_id', 'conversation'], ['id', 'message'], ['sender_type', 'employee'], ['sender_user_id', 'owner']
  ]);
  expect(mocks.adminFrom).not.toHaveBeenCalled();
});
it('reserves metadata with an atomic old-value condition and owner/conversation restrictions', async () => {
  const query = builder({ id: 'message' }); mocks.adminFrom.mockReturnValue(query);
  const source = { id: 'message', metadata: null } as TurnMessage;
  const state: TurnState = { stage: 'generating', token: '11111111-1111-4111-8111-111111111111', attempts: 1, startedAt: new Date().toISOString() };
  expect(await (await createTurnStore('owner', 'conversation')).compareAndSet(source, state)).toBe(true);
  expect(query.is).toHaveBeenCalledWith('metadata', null);
  expect(query.eq).toHaveBeenCalledWith('sender_user_id', 'owner');
  expect(query.eq).toHaveBeenCalledWith('conversation_id', 'conversation');
  expect(query.update).toHaveBeenCalledWith({ metadata: { carwise_ai: state } });
});
it('appends assistant text exclusively through the existing service-only RPC wrapper', async () => {
  mocks.append.mockResolvedValue('reply');
  expect(await (await createTurnStore('owner', 'conversation')).append('תשובה')).toBe('reply');
  expect(mocks.append).toHaveBeenCalledWith('conversation', 'owner', 'תשובה');
  expect(mocks.adminFrom).not.toHaveBeenCalled();
});
it('does not reconcile another turn with the same response text', async () => {
  mocks.history.mockResolvedValue([
    { id: 'source', sender_type: 'employee' }, { id: 'newer-turn', sender_type: 'employee' },
    { id: 'other-reply', sender_type: 'assistant', body: 'same answer' }
  ]);
  expect(await (await createTurnStore('owner', 'conversation')).reconcile({ id: 'source' } as TurnMessage, 'same answer')).toBeNull();
});
it('loads the latest committed business snapshot independently of the 60-message history window',async()=>{
  const user=randomUUID(),conversation=randomUUID();
  const state={schemaVersion:1,revision:70,userId:user,conversationId:conversation,lastProcessedMessageId:randomUUID(),goal:'catalog',preferences:{driveType:'חשמלי'},pendingQuestion:'occupation',pendingFacts:[]};
  const q=builder({metadata:{carwise_ai:{stage:'complete',businessState:state}}});mocks.userFrom.mockReturnValue(q);
  expect(await (await createTurnStore(user,conversation)).memory()).toEqual(state);
  expect(q.eq).toHaveBeenCalledWith('conversation_id',conversation);expect(q.eq).toHaveBeenCalledWith('sender_user_id',user);
  expect(q.eq).toHaveBeenCalledWith('metadata->carwise_ai->>stage','complete');
  expect(q.not).toHaveBeenCalledWith('metadata->carwise_ai->businessState','is',null);
  expect(q.limit).toHaveBeenCalledWith(1);expect(mocks.history).not.toHaveBeenCalled();expect(mocks.adminFrom).not.toHaveBeenCalled();
});
it('rejects a foreign business snapshot despite a malformed database response',async()=>{
  const state={schemaVersion:1,revision:1,userId:randomUUID(),conversationId:randomUUID(),lastProcessedMessageId:randomUUID(),goal:'catalog',preferences:{},pendingQuestion:null,pendingFacts:[]};
  mocks.userFrom.mockReturnValue(builder({metadata:{carwise_ai:{businessState:state}}}));
  await expect((await createTurnStore(randomUUID(),randomUUID())).memory()).rejects.toThrow('AI storage unavailable');
});
