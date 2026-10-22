import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ occupations: vi.fn(), profile: vi.fn(), userFrom: vi.fn(), adminRpc: vi.fn(), adminFrom: vi.fn(), rows: vi.fn(), car: vi.fn() }));
vi.mock('../src/lib/occupation-repository', () => ({ listAdvisorOccupations: mocks.occupations }));
vi.mock('../src/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('../src/lib/supabase-server', () => ({ createSupabaseServerClient: async () => ({ from: mocks.userFrom }) }));
vi.mock('../src/lib/supabase-admin', () => ({ supabaseAdmin: { rpc: mocks.adminRpc, from: mocks.adminFrom } }));
vi.mock('../src/lib/vehicle-repository', () => ({ getActiveVehicleRowsByIds: mocks.rows, toCalculatorCar: mocks.car }));
import { z } from 'zod';
import { runAssistantTurn } from '../src/lib/ai/assistant-service';
import { appendAssistantMessage, getSoleConversationMessage } from '../src/lib/conversation-repository';
import { defaultFinancialDependencies } from '../src/lib/ai/financial-flow';
import { ADVISOR_SYSTEM, advisorPlanSchema, perTurnReferenceData } from '../src/lib/ai/advisor-orchestrator';
import { revealCount } from '../src/components/chat/progressive-text';
import type { TurnMessage, TurnState, TurnStore } from '../src/lib/ai/turn-store';
import type { CalculationRules } from '../src/lib/rules-repository';

/**
 * Latency budget on the critical path, measured with simulated latency (no network, no live services).
 * Each database call is one simulated round trip of ROUND_TRIP_MS; a logical clock counts how many of them are
 * sequential, so the count is exact regardless of timer jitter. The model call has its own simulated latency.
 */
const ROUND_TRIP_MS = 25;
const MODEL_MS = 150;
let clock = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function trip<T>(value: () => T | Promise<T>, weight = 1) {
  return async () => { const start = clock; await sleep(ROUND_TRIP_MS * weight); clock = Math.max(clock, start + weight); return value(); };
}
const plan = JSON.stringify({ action: 'help', intent: 'conversation', filters: {}, operations: [] });
const gemini = () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: plan }] }, finishReason: 'STOP' }] }),
  { headers: { 'content-type': 'application/json' } });

function turnFixture() {
  const userId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID();
  const source: TurnMessage = { id: messageId, conversation_id: conversationId, sender_type: 'employee', sender_user_id: userId,
    body: 'מה זה שווי שימוש?', client_message_id: null, created_at: '2026-10-22T08:00:00.000Z', metadata: null };
  const messages: TurnMessage[] = [source];
  const conversation = { id: conversationId, owner_user_id: userId, title: null, status: 'open' as const,
    created_at: source.created_at, updated_at: source.created_at, last_message_at: source.created_at };
  mocks.profile.mockImplementation(trip(() => ({ userId, role: 'employee' }), 2));
  const query = { select: () => query, eq: () => query, maybeSingle: trip(() => ({ data: conversation, error: null })) };
  mocks.userFrom.mockReturnValue(query);
  mocks.adminRpc.mockImplementation(trip(() => {
    const reply = { ...source, id: randomUUID(), sender_type: 'assistant' as const, sender_user_id: null, body: 'x', metadata: null };
    messages.push(reply); return { data: reply.id, error: null };
  }));
  mocks.occupations.mockImplementation(trip(() => []));
  const store = {
    conversation: trip(() => conversation), source: trip(() => structuredClone(source)), history: trip(() => [...messages]),
    message: async (id: string) => trip(() => messages.find(message => message.id === id) ?? null)(),
    cooldown: trip(() => true, 2), memory: trip(() => null),
    compareAndSet: async (_snapshot: TurnMessage, state: TurnState) => trip(() => {
      source.metadata = JSON.parse(JSON.stringify({ carwise_ai: state })); return true;
    })(),
    // The real repository append: authentication, ownership and the append RPC.
    append: (body: string) => appendAssistantMessage(conversationId, userId, body),
    reconcile: async () => null
  } satisfies TurnStore;
  return { userId, conversationId, source, messages, store,
    run: () => runAssistantTurn({ userId, role: 'employee' }, conversationId, messageId, { store }) };
}

beforeEach(() => {
  clock = 0;
  vi.stubEnv('GEMINI_API_KEY', 'offline-only-test-credential'); vi.stubEnv('GEMINI_MODEL', 'gemini-3.5-flash-lite');
  vi.stubEnv('GROQ_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubGlobal('fetch', vi.fn(async () => { await sleep(MODEL_MS); return gemini(); }));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('chat latency budget (simulated latency, no live services)', () => {
  it('keeps the assistant turn to a bounded number of sequential database round trips', async () => {
    const f = turnFixture();
    const started = performance.now();
    const result = await f.run();
    const wallMs = Math.round(performance.now() - started);
    expect(result.status).toBe('complete');
    console.log('[latency] assistant turn', { sequentialRoundTrips: clock, wallMs, simulatedRoundTripMs: ROUND_TRIP_MS, simulatedModelMs: MODEL_MS });
    expect(clock).toBeLessThanOrEqual(11);
  });

  it('checks authentication and ownership of an assistant append concurrently', async () => {
    const f = turnFixture();
    await appendAssistantMessage(f.conversationId, f.userId, 'x');
    console.log('[latency] assistant append', { sequentialRoundTrips: clock });
    expect(clock).toBeLessThanOrEqual(3);
  });

  it('looks up official tax values for several cars concurrently', async () => {
    const ids = ['CAR-01', 'CAR-02', 'CAR-03', 'CAR-04'];
    mocks.rows.mockImplementation(trip(() => ids.map(id => ({ id }))));
    mocks.car.mockImplementation(async (row: { id: string }) => trip(() => ({ 'מזהה': row.id }))());
    const lookup = await (await defaultFinancialDependencies()).vehicles(ids);
    console.log('[latency] vehicle tax lookups', { cars: ids.length, sequentialRoundTrips: clock });
    expect([...lookup.keys()]).toEqual(ids);
    expect(clock).toBeLessThanOrEqual(2);
  });

  it('sends the model exactly the instructions and JSON contract it received before (built once, not per turn)', async () => {
    const f = turnFixture();
    await f.run();
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0] as unknown as [string, { body: string }])[1].body).systemInstruction.parts[0].text as string;
    const perTurn = ADVISOR_SYSTEM + '\nחוזה JSON מחייב (בלי שדות נוספים):\n' + JSON.stringify(z.toJSONSchema(advisorPlanSchema, { io: 'input' })) + '\nנתוני יישום:\n';
    expect(sent.startsWith(perTurn)).toBe(true);
  });

  it('reveals a complete reply quickly instead of typing it out for seconds', () => {
    const fullAfter = (length: number) => { let t = 0; while (revealCount(length, t) < length) t += 5; return t; };
    const timings = Object.fromEntries([60, 150, 400, 1200].map(length => [length, fullAfter(length)]));
    console.log('[latency] full reveal ms by length', timings);
    for (const ms of Object.values(timings)) expect(ms).toBeLessThanOrEqual(400);
  });
});

describe('the faster turn keeps its safety guarantees', () => {
  const stateOf = (source: TurnMessage) => (source.metadata as { carwise_ai?: TurnState } | null)?.carwise_ai;

  it('still answers 404 for a foreign conversation when the concurrent source read fails', async () => {
    const f = turnFixture();
    f.store.conversation = trip(() => ({ id: f.conversationId, owner_user_id: randomUUID() })) as unknown as typeof f.store.conversation;
    f.store.source = async () => { throw new Error('AI storage unavailable'); };
    await expect(f.run()).rejects.toMatchObject({ status: 404, code: 'AI_NOT_FOUND' });
    expect(mocks.occupations).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('marks the turn failed and saves nothing when the prefetched memory read fails', async () => {
    const f = turnFixture();
    f.store.memory = async () => { throw new Error('AI storage unavailable'); };
    await expect(f.run()).rejects.toMatchObject({ status: 503, code: 'AI_UNAVAILABLE' });
    expect(stateOf(f.source)?.stage).toBe('failed');
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(f.messages).toHaveLength(1);
  });

  it('lets the advisor report occupations as unavailable instead of failing the turn', async () => {
    const f = turnFixture();
    mocks.occupations.mockRejectedValue(new Error('Occupation catalog unavailable'));
    expect((await f.run()).status).toBe('complete');
    expect(f.messages.map(message => message.sender_type)).toEqual(['employee', 'assistant']);
  });

  it('refuses during the cooldown without a model call, even when the prefetched reads fail', async () => {
    const f = turnFixture();
    f.store.cooldown = async () => false;
    f.store.memory = async () => { throw new Error('AI storage unavailable'); };
    mocks.occupations.mockRejectedValue(new Error('Occupation catalog unavailable'));
    await expect(f.run()).rejects.toMatchObject({ status: 429, code: 'AI_RATE_LIMIT' });
    expect(fetch).not.toHaveBeenCalled(); expect(f.source.metadata).toBeNull();
    await sleep(10); // A rejected, unused prefetch must not surface as an unhandled rejection (Vitest fails the run if it does).
  });

  it('never runs the privileged append for a signed-out employee, another account or a missing conversation', async () => {
    const f = turnFixture();
    mocks.profile.mockResolvedValueOnce(null);
    await expect(appendAssistantMessage(f.conversationId, f.userId, 'x')).rejects.toThrow('Employee authentication required');
    mocks.profile.mockResolvedValueOnce({ userId: randomUUID(), role: 'employee' });
    await expect(appendAssistantMessage(f.conversationId, f.userId, 'x')).rejects.toThrow('Employee authentication required');
    mocks.userFrom.mockReturnValueOnce({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) });
    await expect(appendAssistantMessage(f.conversationId, f.userId, 'x')).rejects.toThrow('Conversation not found');
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('keeps per-car tax lookup errors and the requested order when lookups run together', async () => {
    mocks.rows.mockResolvedValue([{ id: 'CAR-01' }, { id: 'CAR-02' }]);
    mocks.car.mockImplementation(async (row: { id: string }) => {
      if (row.id === 'CAR-02') throw new Error('Expected one tax record');
      await sleep(5); return { 'מזהה': row.id };
    });
    const lookup = await (await defaultFinancialDependencies()).vehicles(['CAR-02', 'CAR-03', 'CAR-01']);
    expect([...lookup.entries()]).toEqual([
      ['CAR-02', { error: 'tax_value_missing' }], ['CAR-03', { error: 'not_found' }], ['CAR-01', { car: { 'מזהה': 'CAR-01' } }]
    ]);
  });
});

describe('reference data within one advisor turn', () => {
  const rules = { version: 'rules-v1', groupOrder: ['א', 'ב', 'ג', 'ד'] } as unknown as CalculationRules;
  const page = { vehicles: [{ id: 'CAR-01', display_name: 'ATTO 3', manufacturer_name: 'BYD', group_code: 'ב' as const, drive_type: 'חשמלי' }],
    match: 'single' as const, hasMore: false, nextCursor: null };
  function rulesTable() {
    const limit = vi.fn(async () => ({ data: [{ rules }], error: null }));
    mocks.adminFrom.mockReturnValue({ select: () => ({ eq: () => ({ limit }) }) });
    return limit;
  }

  it('reads the calculation rules once per turn for both the catalog and the calculation, and again next turn', async () => {
    const reads = rulesTable();
    const turn = perTurnReferenceData({});
    expect(await turn.catalog!.rules!()).toEqual(rules);
    expect(await turn.financial!.rules!()).toEqual(rules);
    expect(reads).toHaveBeenCalledTimes(1);
    await perTurnReferenceData({}).financial!.rules!();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('reads each catalog page once per turn and gives every caller its own copy', async () => {
    const search = vi.fn(async () => structuredClone(page));
    const turn = perTurnReferenceData({ catalog: { search } });
    const first = await turn.catalog!.search!({ limit: 50 });
    first.vehicles[0].display_name = 'changed by one caller';
    expect((await turn.catalog!.search!({ limit: 50 })).vehicles[0].display_name).toBe('ATTO 3');
    await turn.catalog!.search!({ limit: 50, driveType: 'חשמלי' });
    expect(search.mock.calls).toEqual([[{ limit: 50 }], [{ limit: 50, driveType: 'חשמלי' }]]);
    // A caller-supplied search never replaces the calculation's own catalog source.
    expect(turn.financial!.catalogRows).toBeUndefined();
  });

  it('does not keep a failed read: the next caller in the turn reads again', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('Vehicle catalog unavailable')).mockResolvedValue(page);
    const turn = perTurnReferenceData({ catalog: { search } });
    await expect(turn.catalog!.search!({ limit: 50 })).rejects.toThrow('Vehicle catalog unavailable');
    expect(await turn.catalog!.search!({ limit: 50 })).toEqual(page);
    expect(search).toHaveBeenCalledTimes(2);
  });
});

describe('the faster path still never shows model-made values', () => {
  const respondWith = (plan: unknown) => vi.stubGlobal('fetch', vi.fn(async () => { await sleep(MODEL_MS); return new Response(JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(plan) }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } }); }));

  it('rejects a model reply that carries its own text or amounts, and saves nothing', async () => {
    const f = turnFixture();
    respondWith({ action: 'net', intent: 'conversation', filters: {}, operations: [], reply: 'הנטו שלך יהיה 9,999 ₪' });
    await expect(f.run()).rejects.toMatchObject({ status: 503 });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(JSON.stringify(f.messages)).not.toContain('9,999');
  });

  it('rejects a salary "fact" that the employee never wrote', async () => {
    const f = turnFixture();
    respondWith({ action: 'net', intent: 'workflow', filters: {}, operations: [
      { type: 'report_fact', field: 'base_salary', value: 25000, evidence: 'השכר שלי 25,000' }] });
    await expect(f.run()).rejects.toMatchObject({ status: 503 });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(JSON.stringify(f.source.metadata)).not.toContain('25000');
  });

  it('reports the model request separately from database work', async () => {
    const f = turnFixture();
    const timing: Record<string, number> = {};
    clock = 0;
    await runAssistantTurn({ userId: f.userId, role: 'employee' }, f.conversationId, f.source.id, { store: f.store, timing });
    expect(Object.keys(timing).sort()).toEqual(['advisor', 'model', 'prepare', 'save']);
    expect(timing.model).toBeGreaterThanOrEqual(MODEL_MS - 5);
    // The model's simulated latency is not counted again in the database phases.
    expect(timing.advisor).toBeLessThan(MODEL_MS);
    expect(timing.prepare).toBeGreaterThanOrEqual(ROUND_TRIP_MS * 3);
    expect(timing.save).toBeGreaterThanOrEqual(ROUND_TRIP_MS * 4);
  });
});

describe('opening a new conversation without reloading it', () => {
  const row = { id: randomUUID(), conversation_id: randomUUID(), sender_type: 'employee', sender_user_id: randomUUID(), body: 'שלום',
    client_message_id: null, created_at: '2026-10-22T08:00:00.000Z' };
  const rows = (data: unknown, error: unknown = null) => {
    const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data, error }) };
    mocks.userFrom.mockReturnValueOnce(query);
  };
  it('returns the message only when it is the conversation\'s sole message', async () => {
    rows([row]); expect(await getSoleConversationMessage(row.conversation_id)).toEqual(row);
    // A retried creation of a conversation that has since continued must reload the whole thread instead.
    rows([row, { ...row, id: randomUUID(), sender_type: 'assistant' }]); expect(await getSoleConversationMessage(row.conversation_id)).toBeNull();
    rows([]); expect(await getSoleConversationMessage(row.conversation_id)).toBeNull();
    rows(null, { code: '42501' }); expect(await getSoleConversationMessage(row.conversation_id)).toBeNull();
  });
});
