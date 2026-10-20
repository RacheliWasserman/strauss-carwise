import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('../src/lib/supabase-admin', () => ({ supabaseAdmin: {} }));
vi.mock('../src/lib/supabase-server', () => ({ createSupabaseServerClient: vi.fn() }));
import { generateCatalogReply, catalogPlanSchema, parseCatalogPlan } from '../src/lib/ai/catalog-advisor';
import { decodeCatalogMessage, encodeCatalogMessage, type CatalogMessage } from '../src/lib/catalog-message';
import { buildContext } from '../src/lib/ai/context';
import type { ConversationMessageRow } from '../src/lib/conversation-repository';
import type { CalculationRules } from '../src/lib/rules-repository';
import type { EmployeeDataVersionRow } from '../src/lib/employee-data-repository';
import { chatMessageSchema } from '../src/lib/chat-client';
const user = randomUUID(), conversation = randomUUID();
function message(body: string, sender_type: ConversationMessageRow['sender_type'] = 'employee', sender = user): ConversationMessageRow {
  return { id: randomUUID(), conversation_id: conversation, body, sender_type, sender_user_id: sender_type === 'assistant' ? null : sender, client_message_id: null, created_at: new Date().toISOString() };
}
const car = (id: string, group_code: 'א'|'ב'|'ג'|'ד'|'משפחתי' = 'א', drive_type = 'חשמלי') => ({ id, group_code, drive_type, display_name: `Fixture ${id}`, manufacturer_name: 'Fixture Maker' });
function setup(filters = {}) {
  const search = vi.fn(async (_input: unknown) => ({ vehicles: [car('A'), car('B','ב'), car('C','ג'), car('D','ד'), car('F','משפחתי')], match: 'multiple' as const, hasMore: false, nextCursor: null as string|null }));
  const rules = vi.fn(async () => ({ version: 'official-fixture', groupOrder: ['א','ב','ג','ד'], familyTrack: { minChildren: 4, cars: ['F'] } } as CalculationRules));
  const confirmed = vi.fn(async (_id: string): Promise<EmployeeDataVersionRow|null> => null);
  const plan = vi.fn(async () => catalogPlanSchema.parse({ action: 'catalog', filters }));
  const history = [message('אני בקבוצה ב'), message('תציעי לי רכב')];
  const run = async (input = history) => decodeCatalogMessage(await generateCatalogReply(user, input, { search, rules, confirmed, plan }))!;
  return { search, rules, confirmed, plan, history, run };
}
describe('closed company catalog advisor', () => {
  it('preserves an explicit electric preference through the exact group clarification, even when the model omits it', async () => {
    const f = setup();
    f.search.mockResolvedValue({vehicles:[car('E-A','א'),car('E-B','ב'),car('E-C','ג'),car('G-A','א','בנזין'),car('H-B','ב','היברידי')],match:'multiple',hasMore:false,nextCursor:null});
    const request = message('אני מחפשת רכב חשמלי');
    const asked = await f.run([request]);
    expect(asked.state.filters.driveType).toBe('חשמלי');
    // A group answer is not a request to change propulsion, even if the model emits one.
    f.plan.mockResolvedValue({action:'catalog',filters:{driveType:'היברידי',group:'ב'}});
    const result = await f.run([request,message(encodeCatalogMessage(asked),'assistant'),message('אני בקבוצה ב׳')]);
    expect(result.cards.map(card=>card.id)).toEqual(['E-A','E-B']);
    expect(f.search).toHaveBeenLastCalledWith({limit:50,driveType:'חשמלי'});
    const restored = decodeCatalogMessage(JSON.parse(JSON.stringify({body:encodeCatalogMessage(result)})).body)!;
    expect(restored.state.filters.driveType).toBe('חשמלי');
    expect(restored.cards.every(card=>card.drive_type==='חשמלי')).toBe(true);
  });
  it('updates only propulsion on an explicit change, then keeps it on later follow-ups', async () => {
    const f = setup({manufacturer:'Fixture Maker',name:'Fixture',driveType:'חשמלי'});
    f.search.mockResolvedValue({vehicles:[car('E','א'),car('H','ב','היברידי'),car('G','א','בנזין')],match:'multiple',hasMore:false,nextCursor:null});
    const first = await f.run();
    f.plan.mockResolvedValue({action:'catalog',filters:{}});
    const changed = await f.run([message(encodeCatalogMessage(first),'assistant'),message('בעצם אני רוצה היברידי')]);
    expect(changed.state.filters).toEqual({manufacturer:'Fixture Maker',name:'Fixture',driveType:'היברידי'});
    expect(changed.cards.map(card=>card.id)).toEqual(['H']);
    expect(decodeCatalogMessage(encodeCatalogMessage(changed))?.cards.every(card=>card.drive_type==='היברידי')).toBe(true);
    const next = await f.run([message(encodeCatalogMessage(changed),'assistant'),message('מה האפשרויות שלי?')]);
    expect(next.state.filters).toEqual(changed.state.filters);
    expect(next.cards.map(card=>card.id)).toEqual(['H']);
  });
  it('starts a fresh search without reusing old preferences or forgetting the reported employee group', async () => {
    const f = setup({manufacturer:'Fixture Maker',driveType:'חשמלי'});
    const first = await f.run();
    const next = await f.run([message(encodeCatalogMessage(first),'assistant'),message('חיפוש חדש')]);
    expect(next.state.group).toBe('ב'); expect(next.state.filters).toEqual({});
    expect(f.search).toHaveBeenLastCalledWith({limit:50});
  });
  it('accepts a complete fenced JSON plan but never extracts a plan from surrounding model prose', () => {
    expect(parseCatalogPlan('```json\n{"action":"catalog","filters":{}}\n```')).toEqual({action:'catalog',filters:{}});
    expect(() => parseCatalogPlan('Buy an invented car. {"action":"catalog","filters":{}}')).toThrow();
  });
  it('only returns active server catalog IDs in the reported group or lower, never family by default', async () => {
    const f = setup(); const result = await f.run();
    expect(result.cards.map(card => card.id)).toEqual(['A','B']);
    expect(result.state.groupSource).toBe('employee_reported');
    expect(result.text).toContain('אינו אישור זכאות');
    expect(f.confirmed).not.toHaveBeenCalled();
  });
  it('uses the official groupOrder instead of hardcoding hierarchy', async () => {
    const f = setup(); f.rules.mockResolvedValue({ ...await f.rules(), groupOrder: ['ד','ג','ב','א'] });
    expect((await f.run()).cards.map(card => card.id)).toEqual(['B','C','D']);
  });
  it('filters name, manufacturer, requested group and propulsion together', async () => {
    const f = setup({name:'fixture B',manufacturer:'maker',group:'ב',driveType:'חשמלי'});
    expect((await f.run()).cards.map(card => card.id)).toEqual(['B']);
    expect((await setup({driveType:'בנזין'}).run()).cards).toEqual([]);
  });
  it('does not present a requested higher group as eligible', async () => {
    const f = setup({group:'ד'}); expect((await f.run()).cards).toEqual([]);
  });
  it('offers to change the search instead of silently dropping an absent vehicle filter', async () => {
    const f = setup({name:'Invented Rocket Car'}); const result = await f.run();
    expect(result.cards).toEqual([]);
    expect(result.text).toContain('חלופות');
    expect(JSON.stringify(result.cards)).not.toContain('Rocket');
  });
  it('asks one group question and remembers the requested filters for the reply', async () => {
    const f = setup({driveType:'חשמלי'});
    const asked = await f.run([message('מחפשת רכב חשמלי')]);
    expect(asked.state.awaitingGroup).toBe(true); expect(asked.cards).toEqual([]);
    expect(f.search).not.toHaveBeenCalled();
    f.plan.mockResolvedValue({action:'catalog',filters:{}});
    const next = await f.run([message(encodeCatalogMessage(asked),'assistant'), message('ב׳')]);
    expect(next.state.filters.driveType).toBe('חשמלי');
    expect(next.cards.map(card => card.id)).toEqual(['A','B']);
  });
  it('does not equate a requested group with the employee group or trust another sender', async () => {
    const f = setup({group:'ד'});
    const result = await f.run([message('אני בקבוצה ד','representative'),message('תראי רכבים מקבוצה ד')]);
    expect(result.state.awaitingGroup).toBe(true); expect(f.search).not.toHaveBeenCalled();
  });
  it('does not persist a reported group across users or conversations outside supplied scoped history', async () => {
    const f = setup();
    expect((await f.run([message('אני בקבוצה ד','employee',randomUUID()),message('רכב')])).cards).toEqual([]);
    expect(f.search).not.toHaveBeenCalled();
  });
  it('replaces a previous reported group with an explicit correction', async () => {
    const f = setup(); const first = await f.run();
    const changed = await f.run([message(encodeCatalogMessage(first),'assistant'),message('הקבוצה שלי היא א')]);
    expect(changed.cards.map(card => card.id)).toEqual(['A']);
  });
  it('accepts explicit group statements with Hebrew punctuation in a longer request', async () => {
    const f = setup();
    const result = await f.run([message('אני בקבוצה ב׳, מחפשת רכב חשמלי')]);
    expect(result.cards.map(card=>card.id)).toEqual(['A','B']);
  });
  it.each(['אם אני בקבוצה ד מה אפשר לקבל?', 'אני בקבוצה ב או ג', 'אני בקבוצה ד אבל לא בטוחה'])('does not turn a hypothetical or uncertain group into eligibility: %s', async body => {
    const f = setup();
    expect((await f.run([message(body)])).state.awaitingGroup).toBe(true);
    expect(f.search).not.toHaveBeenCalled();
  });
  it('offers representative clarification without claiming a request was created', async () => {
    const f = setup(); f.plan.mockResolvedValue({action:'unknown_group',filters:{}});
    const result = await f.run(); expect(result.cards).toEqual([]); expect(result.text).toContain('נציג');
    expect(result.state.group).toBeUndefined(); expect(f.search).not.toHaveBeenCalled();
  });
  it('requires existing confirmed child data and the family allowlist, not conversational claims', async () => {
    const f = setup({group:'משפחתי'});
    expect((await f.run([...f.history,message('יש לי עשרה ילדים')])).cards).toEqual([]);
    expect(f.confirmed).toHaveBeenCalledWith(user);
    f.confirmed.mockResolvedValue({user_id:user,status:'confirmed',eligible_children_count:4} as EmployeeDataVersionRow);
    expect((await f.run()).cards.map(card => card.id)).toEqual(['F']);
    f.rules.mockResolvedValue({...await f.rules(), familyTrack:{...((await f.rules()).familyTrack), cars:[]}});
    expect((await f.run()).cards).toEqual([]);
  });
  it('preserves a family-track request across the group clarification turn', async () => {
    const f = setup(); f.plan.mockResolvedValueOnce({action:'family',filters:{}});
    const asked = await f.run([message('אפשר את המסלול המשפחתי?')]);
    expect(asked.state.filters.group).toBe('משפחתי');
    f.confirmed.mockResolvedValue({user_id:user,status:'confirmed',eligible_children_count:4} as EmployeeDataVersionRow);
    const result = await f.run([message(encodeCatalogMessage(asked),'assistant'),message('ב')]);
    expect(result.cards.map(card=>card.id)).toEqual(['F']);
  });
  it.each([0,3])('does not grant family options for insufficient confirmed children (%s)', async children => {
    const f = setup({group:'משפחתי'});
    f.confirmed.mockResolvedValue({user_id:user,status:'confirmed',eligible_children_count:children} as EmployeeDataVersionRow);
    expect((await f.run()).cards).toEqual([]); expect(f.search).not.toHaveBeenCalled();
  });
  it('rejects family information from another employee or an unconfirmed draft', async () => {
    const f = setup({group:'משפחתי'});
    f.confirmed.mockResolvedValue({user_id:randomUUID(),status:'confirmed',eligible_children_count:8} as EmployeeDataVersionRow);
    expect((await f.run()).cards).toEqual([]);
    f.confirmed.mockResolvedValue({user_id:user,status:'draft',eligible_children_count:8} as EmployeeDataVersionRow);
    expect((await f.run()).cards).toEqual([]);
  });
  it('fails closed on catalog errors even after receiving a partial page', async () => {
    const f = setup(); f.search.mockResolvedValueOnce({vehicles:[car('A')],match:'multiple',hasMore:true,nextCursor:'A'}).mockRejectedValueOnce(new Error('private error'));
    const result = await f.run(); expect(result.cards).toEqual([]); expect(result.text).not.toContain('private');
  });
  it('uses catalog pagination so later matching rows are found', async () => {
    const f = setup({name:'B'});
    f.search.mockResolvedValueOnce({vehicles:[car('C','ג')],match:'multiple',hasMore:true,nextCursor:'C'})
      .mockResolvedValueOnce({vehicles:[car('B')],match:'single' as 'multiple',hasMore:false,nextCursor:null});
    expect((await f.run()).cards.map(card => card.id)).toEqual(['B']);
    expect(f.search).toHaveBeenLastCalledWith({name:'B',limit:50,afterId:'C'});
  });
  it('rejects missing or inconsistent official group rules rather than inventing eligibility', async () => {
    const f = setup(); f.rules.mockResolvedValue({...await f.rules(), groupOrder:['א','א','ג','ד']});
    expect((await f.run()).cards).toEqual([]); expect(f.search).not.toHaveBeenCalled();
  });
  it('survives history serialization and refresh without rerunning the model or catalog', async () => {
    const f = setup(); const result = await f.run();
    const saved = chatMessageSchema.parse(JSON.parse(JSON.stringify(message(encodeCatalogMessage(result),'assistant'))));
    expect(decodeCatalogMessage(saved.body)).toEqual(JSON.parse(JSON.stringify(result)));
    expect(f.plan).toHaveBeenCalledTimes(1); expect(f.search).toHaveBeenCalledTimes(1);
    expect(buildContext([saved])[0].content).toBe(result.text);
  });
  it('does not accept generated vehicle objects or free-form recommendations in model output', async () => {
    expect(catalogPlanSchema.safeParse({action:'catalog',filters:{},cards:[car('forged')]}).success).toBe(false);
    expect(catalogPlanSchema.safeParse({action:'catalog',filters:{employeeGroup:'ד'}}).success).toBe(false);
    const f = setup(); f.plan.mockResolvedValue({action:'catalog',filters:{},reply:'invented'} as never);
    await expect(f.run()).rejects.toThrow(); expect(f.search).not.toHaveBeenCalled();
  });
  it('never renders model prose, including for noncatalog requests', async () => {
    const f = setup(); f.plan.mockResolvedValue({action:'net',filters:{}});
    const result = await f.run(); expect(result.cards).toEqual([]); expect(result.text).toContain('אומדן');
    expect(f.search).not.toHaveBeenCalled();
  });
  it('fails decoding malformed/oversized card envelopes and preserves legacy text', () => {
    expect(decodeCatalogMessage('legacy assistant message')).toBeNull();
    expect(decodeCatalogMessage('{"kind":"carwise.catalog.v1"}')).toBeNull();
    expect(decodeCatalogMessage('{'+ ' '.repeat(6000))).toBeNull();
  });
});
