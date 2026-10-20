import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('../src/lib/supabase-admin', () => ({ supabaseAdmin: {} }));
vi.mock('../src/lib/supabase-server', () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock('../src/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: vi.fn() }));
import { runAssistantTurn } from '../src/lib/ai/assistant-service';
import { generateReply, ProviderFailure } from '../src/lib/ai/providers';
import type { TurnMessage, TurnState, TurnStore } from '../src/lib/ai/turn-store';
import type { ConversationMessageRow } from '../src/lib/conversation-repository';
import type { AiContext } from '../src/lib/ai/context';

function fixture() {
  const userId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID();
  const source: TurnMessage = { id: messageId, conversation_id: conversationId, sender_type: 'employee', sender_user_id: userId,
    body: 'איזה רכב מתאים לי?', created_at: new Date().toISOString(), client_message_id: null, metadata: null };
  const messages: ConversationMessageRow[] = [source];
  const conversation = { id: conversationId, owner_user_id: userId, title: null, status: 'open' as const,
    created_at: source.created_at, updated_at: source.created_at, last_message_at: source.created_at };
  const store = {
    conversation: vi.fn(async () => conversation), source: vi.fn(async () => structuredClone(source)),
    history: vi.fn(async () => messages), message: vi.fn(async (id: string) => messages.find(item => item.id === id) ?? null),
    compareAndSet: vi.fn(async (snapshot: TurnMessage, state: TurnState) => {
      if (JSON.stringify(snapshot.metadata) !== JSON.stringify(source.metadata)) return false;
      source.metadata = JSON.parse(JSON.stringify({ ...source.metadata, carwise_ai: state })); return true;
    }),
    cooldown: vi.fn(async () => true),
    append: vi.fn(async (body: string) => {
      const reply: ConversationMessageRow = { ...source, id: randomUUID(), body, sender_type: 'assistant', sender_user_id: null };
      messages.push(reply); return reply.id;
    }),
    reconcile: vi.fn(async (_source: TurnMessage, body: string) => messages.find(item => item.sender_type === 'assistant' && item.body === body) ?? null)
  } satisfies TurnStore;
  const generate = vi.fn(async (_context: AiContext) => 'בשמחה! מה התפקיד שלך בשטראוס?');
  const profile = { userId, role: 'employee' as const };
  const run = () => runAssistantTurn(profile, conversationId, messageId, { store, generate });
  return { source, messages, store, generate, profile, conversationId, messageId, run };
}

describe('authenticated assistant turn coordination', () => {
  it('generates Hebrew from saved history and appends the assistant once', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.status).toBe('complete');
    expect(f.store.append).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls[0][0]).toEqual([{ role: 'user', content: f.source.body }]);
    expect(f.messages.map(item => item.sender_type)).toEqual(['employee', 'assistant']);
  });

  it('returns the saved reply after refresh/retry without another model or append call', async () => {
    const f = fixture(); const first = await f.run(); const restored = await f.run();
    expect(restored).toEqual(first);
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.store.append).toHaveBeenCalledTimes(1);
  });

  it('saves exactly one selected reply after three-provider fallback and a replay', async () => {
    const f = fixture(); const order: string[] = [];
    f.generate.mockImplementationOnce(context => generateReply(context, [
      { name: 'gemini', generate: async () => { order.push('gemini'); throw new ProviderFailure(true); } },
      { name: 'groq', generate: async () => { order.push('groq'); throw new ProviderFailure(true); } },
      { name: 'openrouter', generate: async () => { order.push('openrouter'); return 'בשמחה! מה התפקיד שלך?'; } }
    ]));
    await f.run(); await f.run();
    expect(order).toEqual(['gemini', 'groq', 'openrouter']);
    expect(f.store.append).toHaveBeenCalledTimes(1); expect(f.messages).toHaveLength(2);
  });

  it('rejects another owner before loading messages or contacting providers', async () => {
    const f = fixture(); f.store.conversation.mockResolvedValueOnce({ ...await f.store.conversation(), owner_user_id: randomUUID() });
    await expect(f.run()).rejects.toMatchObject({ status: 404 });
    expect(f.store.history).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });

  it('rejects a forged message from another conversation/user', async () => {
    const f = fixture(); f.store.source.mockResolvedValueOnce({ ...f.source, conversation_id: randomUUID(), sender_user_id: randomUUID() });
    await expect(f.run()).rejects.toMatchObject({ status: 404 });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('keeps the employee message when all providers fail and permits a bounded manual retry', async () => {
    const f = fixture(); f.generate.mockRejectedValueOnce(new ProviderFailure(true));
    await expect(f.run()).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(f.messages).toHaveLength(1); expect(f.messages[0].body).toBe(f.source.body);
    expect(f.store.append).not.toHaveBeenCalled();
    expect((await f.run()).status).toBe('complete'); expect(f.store.append).toHaveBeenCalledTimes(1);
  });

  it('makes simultaneous retries return pending while only one model request runs', async () => {
    const f = fixture(); let release!: (value: string) => void; let started!: () => void;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    f.generate.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const first = f.run(); await beginning;
    expect(await f.run()).toEqual({ status: 'pending' });
    release('מה התפקיד שלך?'); await first;
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.store.append).toHaveBeenCalledTimes(1);
  });

  it('never repeats an append when RPC commit status is unknown', async () => {
    const f = fixture(); f.store.append.mockRejectedValueOnce(new Error('network failure'));
    await expect(f.run()).rejects.toMatchObject({ code: 'AI_SAVE_UNCERTAIN' });
    await expect(f.run()).rejects.toMatchObject({ code: 'AI_SAVE_UNCERTAIN' });
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.store.append).toHaveBeenCalledTimes(1);
  });

  it('reconciles a committed reply whose RPC response was lost', async () => {
    const f = fixture();
    f.store.append.mockImplementationOnce(async body => {
      f.messages.push({ ...f.source, id: randomUUID(), sender_type: 'assistant', sender_user_id: null, body });
      throw new Error('lost response');
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'AI_SAVE_UNCERTAIN' });
    expect((await f.run()).status).toBe('complete');
    expect(f.messages).toHaveLength(2); expect(f.store.append).toHaveBeenCalledTimes(1);
  });

  it('does not regenerate on status-only polls after a provider failure', async () => {
    const f = fixture(); f.generate.mockRejectedValueOnce(new ProviderFailure(true));
    await expect(f.run()).rejects.toThrow();
    await expect(runAssistantTurn(f.profile, f.conversationId, f.messageId, { store: f.store, generate: f.generate, statusOnly: true })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('enforces the persistent per-user cooldown before any provider request', async () => {
    const f = fixture(); f.store.cooldown.mockResolvedValueOnce(false);
    await expect(f.run()).rejects.toMatchObject({ status: 429 });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('stops after three generation attempts for a turn', async () => {
    const f = fixture(); f.source.metadata = { carwise_ai: { stage: 'failed', token: randomUUID(), attempts: 3, startedAt: new Date().toISOString() } };
    const savedState = structuredClone(f.source.metadata);
    await expect(f.run()).rejects.toMatchObject({ code: 'AI_TURN_LIMIT' }); expect(f.generate).not.toHaveBeenCalled();
    expect(f.source.metadata).toEqual(savedState);
    expect(f.store.cooldown).not.toHaveBeenCalled();
    expect(f.store.compareAndSet).not.toHaveBeenCalled();
    expect(f.store.append).not.toHaveBeenCalled();
  });

  it('does not save a result after losing its compare-and-set lease', async () => {
    const f = fixture(); f.generate.mockImplementationOnce(async () => {
      f.source.metadata = { changedByAnotherWorker: true }; return 'תשובה מאוחרת';
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'AI_IN_PROGRESS' }); expect(f.store.append).not.toHaveBeenCalled();
  });

  it('never includes another conversation in provider context even if a repository regresses', async () => {
    const f = fixture();
    f.messages.unshift({ ...f.source, id: randomUUID(), conversation_id: randomUUID(), body: 'foreign-user-sensitive-content' });
    await f.run();
    expect(JSON.stringify(f.generate.mock.calls)).not.toContain('foreign-user-sensitive-content');
  });

  it('rejects obsolete turns instead of generating against a newer employee message', async () => {
    const f = fixture(); f.messages.push({ ...f.source, id: randomUUID(), body: 'newer request' });
    await expect(f.run()).rejects.toMatchObject({ code: 'AI_TURN_OUTDATED' });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('enforces the per-process per-user minute budget across distinct turns', async () => {
    const f = fixture();
    for (let index = 0; index < 8; index++) {
      f.source.id = randomUUID(); f.source.metadata = null; f.messages.splice(0, f.messages.length, f.source);
      await runAssistantTurn(f.profile, f.conversationId, f.source.id, { store: f.store, generate: f.generate });
    }
    f.source.id = randomUUID(); f.source.metadata = null; f.messages.splice(0, f.messages.length, f.source);
    await expect(runAssistantTurn(f.profile, f.conversationId, f.source.id, { store: f.store, generate: f.generate })).rejects.toMatchObject({ status: 429 });
    expect(f.generate).toHaveBeenCalledTimes(8);
  });
});
