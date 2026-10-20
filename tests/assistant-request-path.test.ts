import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ store: undefined as unknown, profile: vi.fn(), search: vi.fn(), rules: vi.fn(), occupations:vi.fn() }));
vi.mock('../src/lib/occupation-repository',()=>({listAdvisorOccupations:mocks.occupations}));
vi.mock('../src/lib/advisor-catalog-service', () => ({ searchAdvisorVehicles: mocks.search }));
vi.mock('../src/lib/rules-repository', () => ({ getCalculationRules: mocks.rules }));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
// Vitest has no Next.js @ alias resolver: bridge it to the actual module.
vi.mock('@/lib/ai/assistant-service', async () => import('../src/lib/ai/assistant-service'));
vi.mock('../src/lib/supabase-admin', () => ({ supabaseAdmin: {} }));
vi.mock('../src/lib/supabase-server', () => ({ createSupabaseServerClient: () => { throw new Error('Database access forbidden in this test'); } }));
vi.mock('../src/lib/ai/turn-store', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/ai/turn-store')>(),
  createTurnStore: async () => mocks.store
}));
// Keep the real route, service, context builder, providers and Google SDK.
import { POST } from '../src/app/api/conversations/[conversationId]/assistant/route';
import { AI_LIMITS } from '../src/lib/ai/config';
import { ADVISOR_SYSTEM } from '../src/lib/ai/advisor-orchestrator';
import { decodeCatalogMessage } from '../src/lib/catalog-message';
import { geminiDiagnostic } from '../src/lib/ai/gemini-diagnostics';
import type { TurnMessage, TurnState, TurnStore } from '../src/lib/ai/turn-store';
const { runStage } = createRequire(import.meta.url)('../scripts/diagnose-gemini-stages.cjs');
const ok = (action = 'greeting',operations:unknown[] = []) => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ action, filters: {},operations }) }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });

function fixture(body: string) {
  const userId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID();
  const source: TurnMessage = { id: messageId, conversation_id: conversationId, sender_type: 'employee', sender_user_id: userId,
    body, client_message_id: null, created_at: '2026-10-19T00:00:00.000Z', metadata: null };
  const messages: TurnMessage[] = [source];
  const store = {
    conversation: vi.fn(async () => ({ id: conversationId, owner_user_id: userId })),
    source: vi.fn(async () => structuredClone(source)), history: vi.fn(async () => [...messages]),
    message: vi.fn(async (id: string) => messages.find(message => message.id === id) ?? null),
    cooldown: vi.fn(async () => true),
    compareAndSet: vi.fn(async (_snapshot: TurnMessage, state: TurnState) => { source.metadata = JSON.parse(JSON.stringify({ carwise_ai: state })); return true; }),
    append: vi.fn(async (text: string) => {
      const reply = { ...source, id: randomUUID(), sender_type: 'assistant' as const, sender_user_id: null, body: text, metadata: null };
      messages.push(reply); return reply.id;
    }), reconcile: vi.fn(async () => null)
  };
  mocks.store = store as unknown as TurnStore;
  mocks.profile.mockResolvedValue({ userId, role: 'employee' });
  const call = () => POST(new Request(`http://localhost/api/conversations/${conversationId}/assistant`, {
    method: 'POST', body: JSON.stringify({ messageId })
  }), { params: Promise.resolve({ conversationId }) });
  return { call, store, source };
}
beforeEach(() => {
  mocks.occupations.mockResolvedValue([]);
  vi.stubEnv('GEMINI_API_KEY', 'offline-only-test-credential');
  vi.stubEnv('GEMINI_MODEL', 'gemini-3.5-flash-lite');
  vi.stubEnv('GROQ_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('keeps probe JSON and SDK headers unchanged with the catalog system instruction and intentional deadline increase', async () => {
  const apiTransport = vi.fn(async () => ok()); vi.stubGlobal('fetch', apiTransport);
  const f = fixture('Reply only OK.');
  expect((await f.call()).status).toBe(200);
  expect(apiTransport).toHaveBeenCalledTimes(1);
  const probeTransport = vi.fn(async () => ok());
  const actualSystem=JSON.parse((apiTransport.mock.calls[0] as unknown as [string,{body:string}])[1].body).systemInstruction.parts[0].text;
  expect(actualSystem.startsWith(ADVISOR_SYSTEM)).toBe(true);
  const probe = await runStage('sdk-chat-timeout', { AI_LIMITS, CARWISE_SYSTEM: actualSystem }, geminiDiagnostic, {
    key: 'offline-only-test-credential', send: probeTransport, GoogleGenAI
  });
  expect(probe.diagnostic).toBe('accepted');
  type Call = [string, RequestInit & { body: string }];
  const [apiUrl, apiOptions] = apiTransport.mock.calls[0] as unknown as Call;
  const [probeUrl, probeOptions] = probeTransport.mock.calls[0] as unknown as Call;
  expect(apiUrl).toBe(probeUrl);
  expect(apiOptions.method).toBe(probeOptions.method);
  expect(JSON.parse(apiOptions.body)).toEqual(JSON.parse(probeOptions.body));
  // Hash headers in assertions too: a failure must not print credential values.
  const headerDigest = (headers?: HeadersInit) => {
    const selected = new Headers(headers); selected.delete('x-server-timeout');
    return createHash('sha256').update(JSON.stringify([...selected.entries()].sort())).digest('hex');
  };
  expect(headerDigest(apiOptions.headers)).toBe(headerDigest(probeOptions.headers));
  expect(new Headers(apiOptions.headers).get('x-server-timeout')).toBe('20');
  expect(new Headers(probeOptions.headers).get('x-server-timeout')).toBe('7');
  expect(f.store.append).toHaveBeenCalledTimes(1);
});

it.each([
  { name: 'Hebrew', text: 'היי, אני רוצה לבדוק אפשרויות רכב' },
  { name: 'outer whitespace and line breaks', text: ' \tהיי\nאפשר לבדוק?\r\n ' },
  { name: 'emoji', text: 'היי 😀 אשמח לעזרה' },
  { name: 'Unicode controls', text: 'היי\u202E\u2066\uFFFD\u0001 בדיקה' }
])('serializes fictional $name through the real API path without unexpected text transformations', async ({ text }) => {
  const transport = vi.fn(async () => ok()); vi.stubGlobal('fetch', transport);
  expect((await fixture(text).call()).status).toBe(200);
  const options = (transport.mock.calls[0] as unknown as [string, { body: string }])[1];
  const body = JSON.parse(options.body);
  expect(body.contents).toEqual([{ role: 'user', parts: [{ text }] }]);
  expect(body.systemInstruction.parts[0].text.startsWith(ADVISOR_SYSTEM)).toBe(true);
  expect(body.generationConfig).toEqual({ maxOutputTokens: 700 });
  expect(transport).toHaveBeenCalledTimes(1);
  const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
  expect(logs).not.toContain(text);
});

it('retains the real Google HTTP 400 classification through the API without retrying', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', transport);
  const f = fixture('Reply only OK.');
  const response = await f.call();
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe('AI_REJECTED');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(f.store.append).not.toHaveBeenCalled();
  expect(f.source.body).toBe('Reply only OK.');
});

it('does not reset or bypass a capped saved turn through the real API path', async () => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  const f = fixture('Reply only OK.');
  f.source.metadata = { carwise_ai: { stage: 'failed', attempts: 3, token: randomUUID(), startedAt: '2026-10-19T00:00:00.000Z' } };
  const before = structuredClone(f.source);
  const response = await f.call();
  expect(response.status).toBe(429);
  expect((await response.json()).code).toBe('AI_TURN_LIMIT');
  expect(transport).not.toHaveBeenCalled();
  expect(f.store.compareAndSet).not.toHaveBeenCalled();
  expect(f.source).toEqual(before);
});

it('uses the default API path to save verified cards once and returns them after refresh/retry', async () => {
  const transport = vi.fn(async () => ok('catalog',[{type:'report_group',value:'ב',evidence:'אני בקבוצה ב'}])); vi.stubGlobal('fetch', transport);
  mocks.rules.mockResolvedValue({version:'fixture-v1',groupOrder:['א','ב','ג','ד'],familyTrack:{minChildren:4,cars:[]}});
  const base = {display_name:'Fixture car',manufacturer_name:'Fixture',drive_type:'חשמלי'};
  mocks.search.mockResolvedValue({vehicles:[{...base,id:'REAL-FIXTURE-A',group_code:'א'},{...base,id:'REAL-FIXTURE-D',group_code:'ד'}],hasMore:false,nextCursor:null});
  const f = fixture('אני בקבוצה ב');
  const response = await f.call(); expect(response.status).toBe(200);
  const first = await response.json();
  expect(decodeCatalogMessage(first.message.body)?.cards.map(card => card.id)).toEqual(['REAL-FIXTURE-A']);
  const refreshed = await f.call(); expect(await refreshed.json()).toEqual(first);
  expect(transport).toHaveBeenCalledTimes(1); expect(f.store.append).toHaveBeenCalledTimes(1);
});

it('does not query catalog or providers for an anonymous or wrong-role request', async () => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  const f = fixture('אני בקבוצה ד'); mocks.search.mockClear();
  mocks.profile.mockResolvedValueOnce(null);
  expect((await f.call()).status).toBe(401);
  mocks.profile.mockResolvedValueOnce({userId:randomUUID(),role:'representative'});
  expect((await f.call()).status).toBe(403);
  expect(transport).not.toHaveBeenCalled(); expect(mocks.search).not.toHaveBeenCalled();
});
it('runs occupation matching through the real API/SDK/orchestrator and commits business memory exactly once',async()=>{
  const key='a'.repeat(64);
  mocks.occupations.mockResolvedValue([{key,title:'מפתח/ת תוכנה',group_code:'ב',car_mandatory:false,waiver_allowed:true,waiver_maintenance_amount:1000}]);
  const transport=vi.fn(async()=>ok('catalog',[{type:'report_occupation',reportedTitle:'מפתחת תוכנה',evidence:'מפתחת תוכנה',candidateKeys:[key],certainty:'clear'}]));
  vi.stubGlobal('fetch',transport);
  mocks.rules.mockResolvedValue({version:'fixture-v1',groupOrder:['א','ב','ג','ד'],familyTrack:{minChildren:4,cars:[]}});
  const base={display_name:'Fixture car',manufacturer_name:'Fixture'};
  mocks.search.mockResolvedValue({vehicles:[{...base,id:'E-B',group_code:'ב',drive_type:'חשמלי'},{...base,id:'H-B',group_code:'ב',drive_type:'היברידי'},{...base,id:'E-C',group_code:'ג',drive_type:'חשמלי'}],hasMore:false,nextCursor:null});
  const f=fixture('אני מפתחת תוכנה ומחפשת רכב חשמלי');
  const response=await f.call();expect(response.status).toBe(200);
  const first=await response.json();
  expect(decodeCatalogMessage(first.message.body)?.cards.map(card=>card.id)).toEqual(['E-B']);
  expect(f.source.metadata?.carwise_ai).toMatchObject({stage:'complete',businessState:{preferences:{driveType:'חשמלי'},group:'ב',groupSource:'occupation_match',occupation:{officialRoleVerified:false}}});
  expect(await (await f.call()).json()).toEqual(first);
  expect(f.store.append).toHaveBeenCalledTimes(1);expect(transport).toHaveBeenCalledTimes(1);
});
it('recovers from a Gemini HTTP 200 with invalid plan JSON through Groq on the real assistant route',async()=>{
  vi.stubEnv('GROQ_API_KEY','offline-backup-credential');
  const key='a'.repeat(64);
  mocks.occupations.mockResolvedValue([{key,title:'מפתח/ת תוכנה',group_code:'ב',car_mandatory:false,waiver_allowed:true,waiver_maintenance_amount:1000}]);
  mocks.rules.mockResolvedValue({version:'fixture-v1',groupOrder:['א','ב','ג','ד'],familyTrack:{minChildren:4,cars:[]}});
  mocks.search.mockResolvedValue({vehicles:[{id:'E-B',display_name:'Fixture',manufacturer_name:'Fixture',group_code:'ב',drive_type:'חשמלי'}],hasMore:false,nextCursor:null});
  const plan={action:'catalog',filters:{},operations:[{type:'report_occupation',reportedTitle:'מפתחת תוכנה',evidence:'מפתחת תוכנה',candidateKeys:[key],certainty:'clear'}]};
  const transport=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'{"action":'}]},finishReason:'STOP'}]}),{headers:{'content-type':'application/json'}}))
    .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}}));
  vi.stubGlobal('fetch',transport);
  const f=fixture('אני מפתחת תוכנה ומחפשת רכב חשמלי');
  const response=await f.call();expect(response.status).toBe(200);
  expect(decodeCatalogMessage((await response.json()).message.body)?.cards.map(card=>card.id)).toEqual(['E-B']);
  expect(transport).toHaveBeenCalledTimes(2);expect(f.store.append).toHaveBeenCalledTimes(1);
  await f.call();expect(f.store.append).toHaveBeenCalledTimes(1);expect(transport).toHaveBeenCalledTimes(2);
});
it('keeps the employee message and returns a friendly error without a business reply when all plans are invalid',async()=>{
  vi.stubEnv('GROQ_API_KEY','offline-backup');vi.stubEnv('OPENROUTER_API_KEY','offline-final');
  const transport=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'broken'}]},finishReason:'STOP'}]})))
    .mockImplementation(async()=>new Response(JSON.stringify({choices:[{message:{content:'broken'},finish_reason:'stop'}]})));
  vi.stubGlobal('fetch',transport);
  // A message the server cannot understand on its own still fails visibly; nothing is guessed or saved.
  const unclear='תגידי, מה את חושבת על ההפרשות שלי?';
  const f=fixture(unclear);const response=await f.call();
  expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'AI_UNAVAILABLE',error:expect.stringContaining('נשמרה')});
  expect(f.source.body).toBe(unclear);expect(f.store.append).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(3);
});
it('answers a clear occupation + car request through the real route when every provider fails',async()=>{
  vi.stubEnv('GROQ_API_KEY','offline-backup');vi.stubEnv('OPENROUTER_API_KEY','offline-final');
  const transport=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'broken'}]},finishReason:'STOP'}]})))
    .mockImplementation(async()=>new Response(JSON.stringify({choices:[{message:{content:'broken'},finish_reason:'stop'}]})));
  vi.stubGlobal('fetch',transport);
  const f=fixture('אני מפתחת תוכנה ומחפשת רכב חשמלי');const response=await f.call();
  expect(response.status).toBe(200);expect(transport).toHaveBeenCalledTimes(3); // All three providers were genuinely tried.
  expect(f.store.append).toHaveBeenCalledTimes(1);
});
it('distinguishes a local memory failure from provider failures without leaking its error text',async()=>{
  const transport=vi.fn();vi.stubGlobal('fetch',transport);
  const f=fixture('שלום');Object.assign(f.store,{memory:async()=>{throw new Error('private salary and cookie');}});
  expect((await f.call()).status).toBe(503);expect(transport).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith('[carwise.ai.turn]',expect.objectContaining({phase:'memory',kind:'local_failure'}));
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private salary and cookie');
});
