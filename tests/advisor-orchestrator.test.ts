import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('../src/lib/supabase-admin',()=>({supabaseAdmin:{}}));
vi.mock('../src/lib/supabase-server',()=>({createSupabaseServerClient:vi.fn()}));
const profileWrites=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/employee-data-repository',()=>({createEmployeeDataVersion:profileWrites,getLatestConfirmedEmployeeData:vi.fn(async()=>null)}));
import {runAdvisorTurn,advisorPlanSchema} from '../src/lib/ai/advisor-orchestrator';
import {advisorStateSchema,type AdvisorState} from '../src/lib/ai/advisor-state';
import {decodeCatalogMessage} from '../src/lib/catalog-message';
import type {AdvisorOccupation} from '../src/lib/occupation-repository';
import type {CalculationRules} from '../src/lib/rules-repository';
import type {ConversationMessageRow} from '../src/lib/conversation-repository';

const developer:AdvisorOccupation={key:'a'.repeat(64),title:'מפתח/ת תוכנה',group_code:'ב',car_mandatory:false,waiver_allowed:true,waiver_maintenance_amount:1234};
const technician:AdvisorOccupation={...developer,key:'b'.repeat(64),title:'טכנאי/ת שירות',group_code:'א',car_mandatory:true,waiver_allowed:false,waiver_maintenance_amount:0};
const vehicle=(id:string,group_code:'א'|'ב'|'ג',drive_type:string)=>({id,display_name:'Fixture '+id,manufacturer_name:'Fixture',group_code,drive_type});
function fixture() {
  const user=randomUUID(),conversation=randomUUID();
  const message=(body:string):ConversationMessageRow=>({id:randomUUID(),conversation_id:conversation,sender_type:'employee',sender_user_id:user,body,client_message_id:null,created_at:new Date().toISOString()});
  const occupations=vi.fn(async()=>[developer,technician]);
  const plan=vi.fn(async()=>advisorPlanSchema.parse({action:'catalog',filters:{}}));
  const search=vi.fn(async(_input:unknown)=>({vehicles:[vehicle('E-A','א','חשמלי'),vehicle('E-B','ב','חשמלי'),vehicle('E-C','ג','חשמלי'),vehicle('H-A','א','היברידי'),vehicle('H-B','ב','היברידי'),vehicle('G-A','א','בנזין')],match:'multiple' as const,hasMore:false,nextCursor:null}));
  const rules=vi.fn(async()=>({version:'fixture-v1',groupOrder:['א','ב','ג','ד'],familyTrack:{minChildren:4,cars:[]}} as unknown as CalculationRules));
  const run=(messages:ConversationMessageRow[],previous:AdvisorState|null=null)=>runAdvisorTurn(user,conversation,messages,previous,{occupations,plan,catalog:{search,rules}});
  const report=(reportedTitle:string,key=developer.key)=>({type:'report_occupation',reportedTitle,evidence:reportedTitle,candidateKeys:[key],certainty:'clear'});
  const identify=()=>plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',goal:'recommendation',filters:{},operations:[report('מפתחת תוכנה')]}));
  return {user,conversation,message,occupations,plan,search,rules,run,report,identify};
}
it('matches the feminine occupation to a real table candidate, derives group B and returns only allowed electric cards',async()=>{
  const f=fixture();f.identify();
  const result=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי')]);
  expect(result.state.occupation?.match).toEqual(developer);
  expect(result.state.occupation?.officialRoleVerified).toBe(false);
  expect(result.state.groupSource).toBe('occupation_match');
  expect(result.state.pendingQuestion).toBeNull();
  expect(decodeCatalogMessage(result.body)?.cards.map(card=>card.id)).toEqual(['E-A','E-B']);
  expect(result.body).not.toContain('מה קבוצת');
  expect(decodeCatalogMessage(result.body)!.text).not.toMatch(/קבוצה [אבגד]|טבלת|אימות רשמי|התאמתי את העיסוק/);
  expect(f.search).toHaveBeenCalledWith({driveType:'חשמלי',limit:50});
});
it('updates the propulsion without losing occupation, goal or group, including after state reload with no old history',async()=>{
  const f=fixture();f.identify();
  const first=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי')]);
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{type:'set_preference',field:'driveType',value:'היברידי',evidence:'בעצם אני רוצה היברידי'}]}));
  const restored=advisorStateSchema.parse(JSON.parse(JSON.stringify(first.state)));
  const changed=await f.run([f.message('בעצם אני רוצה היברידי')],restored);
  expect(changed.state.occupation?.match).toEqual(developer);
  expect(changed.state.goal).toBe('recommendation');
  expect(changed.state.group).toBe('ב');expect(changed.state.preferences.driveType).toBe('היברידי');
  expect(decodeCatalogMessage(changed.body)?.cards.map(card=>card.id)).toEqual(['H-A','H-B']);
  expect(decodeCatalogMessage(JSON.parse(JSON.stringify({body:changed.body})).body)?.cards.every(card=>card.drive_type==='היברידי')).toBe(true);
});
it('keeps the electric request and net goal through the occupation clarification',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'net',goal:'net',filters:{}}));
  const asked=await f.run([f.message('אני רוצה רכב חשמלי, כמה זה בנטו?')]);
  expect(asked.state.pendingQuestion).toBe('occupation');expect(f.search).not.toHaveBeenCalled();
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[f.report('מפתחת תוכנה')]}));
  const answer=await f.run([f.message('אני מפתחת תוכנה')],asked.state);
  expect(answer.state.goal).toBe('net');expect(answer.state.preferences.driveType).toBe('חשמלי');
  expect(decodeCatalogMessage(answer.body)?.cards.map(card=>card.id)).toEqual(['E-A','E-B']);
});
it('does not forget an unanswered occupation question on a greeting interlude',async()=>{
  const f=fixture();const asked=await f.run([f.message('אני רוצה רכב חשמלי')]);
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'greeting',filters:{}}));
  const next=await f.run([f.message('תודה')],asked.state);
  expect(next.state.pendingQuestion).toBe('occupation');expect(next.state.preferences.driveType).toBe('חשמלי');
});
it('uses structured operations for a natural preference change without a fixed electric keyword',async()=>{
  const f=fixture();f.identify();const first=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב היברידי')]);
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{type:'set_preference',field:'driveType',value:'חשמלי',evidence:'רק עם סוללה בלי דלק'}]}));
  const result=await f.run([f.message('עדיף לי רק עם סוללה בלי דלק')],first.state);
  expect(decodeCatalogMessage(result.body)?.cards.map(card=>card.id)).toEqual(['E-A','E-B']);
});
it('asks one clarification for multiple candidates and accepts only a choice from those candidates',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{...f.report('עוסקת בשירות'),candidateKeys:[developer.key,technician.key],certainty:'uncertain'}]}));
  const asked=await f.run([f.message('אני עוסקת בשירות ורוצה רכב חשמלי')]);
  expect(asked.state.pendingQuestion).toBe('occupation_choice');expect(f.search).not.toHaveBeenCalled();
  expect(decodeCatalogMessage(asked.body)?.text.match(/\?/g)).toHaveLength(1);
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{type:'choose_occupation',candidateKey:developer.key,evidence:'הראשון'}]}));
  const answer=await f.run([f.message('הראשון')],asked.state);
  expect(answer.state.group).toBe('ב');expect(answer.state.preferences.driveType).toBe('חשמלי');
});
it('offers representative clarification for an unmatched occupation, never an invented group',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{...f.report('מקצוע לא מוכר'),candidateKeys:[]}]}));
  const result=await f.run([f.message('אני במקצוע לא מוכר ומחפשת רכב')]);
  expect(result.state.pendingQuestion).toBe('representative');expect(result.state.group).toBeUndefined();
  expect(decodeCatalogMessage(result.body)?.cards).toEqual([]);expect(f.search).not.toHaveBeenCalled();
});
it('fails closed if the real occupations repository is unavailable',async()=>{
  const f=fixture();f.occupations.mockRejectedValue(new Error('private token'));
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{...f.report('מפתחת תוכנה'),candidateKeys:[]}]}));
  const result=await f.run([f.message('אני מפתחת תוכנה')]);
  expect(result.state.occupation?.status).toBe('unavailable');expect(result.body).not.toContain('private token');expect(f.search).not.toHaveBeenCalled();
});
it('revalidates official group values each turn rather than trusting cached occupation conditions',async()=>{
  const f=fixture();f.identify();const first=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי')]);
  f.occupations.mockResolvedValue([{...developer,group_code:'א'},technician]);
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{}}));
  const next=await f.run([f.message('אפשר לראות שוב?')],first.state);
  expect(next.state.group).toBe('א');expect(decodeCatalogMessage(next.body)?.cards.map(card=>card.id)).toEqual(['E-A']);
});
it('updates an occupation without clearing preferences and prevents stale higher-group recommendations',async()=>{
  const f=fixture();f.identify();const first=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי')]);
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[f.report('טכנאית שירות',technician.key)]}));
  const result=await f.run([f.message('בעצם אני טכנאית שירות')],first.state);
  expect(result.state.occupation?.match?.car_mandatory).toBe(true);
  expect(decodeCatalogMessage(result.body)?.cards.map(card=>card.id)).toEqual(['E-A']);
});
it('keeps employee facts pending in conversation memory and never writes employee versions',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'help',filters:{},operations:[{type:'report_fact',field:'base_salary',value:15000,evidence:'15000'}]}));
  const result=await f.run([f.message('השכר שלי הוא 15000')]);
  expect(result.state.pendingFacts).toEqual([{field:'base_salary',value:15000,status:'pending_confirmation',sourceMessageId:result.state.lastProcessedMessageId}]);
  expect(profileWrites).not.toHaveBeenCalled();
});
it('rejects fabricated keys, invented business fields and facts without latest-message evidence',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[f.report('מפתחת תוכנה','c'.repeat(64))]}));
  await expect(f.run([f.message('אני מפתחת תוכנה')])).rejects.toThrow('Unknown occupation candidate');
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[f.report('מפתחת תוכנה')]}));
  await expect(f.run([f.message('מה נשמע?')])).rejects.toThrow('source evidence');
  expect(advisorPlanSchema.safeParse({action:'catalog',filters:{},group:'ד'}).success).toBe(false);
  expect(f.search).not.toHaveBeenCalled();
});
it('rejects state or messages from another user/conversation before reading any catalog',async()=>{
  const f=fixture();f.identify();const first=await f.run([f.message('אני מפתחת תוכנה')]);f.occupations.mockClear();
  await expect(f.run([f.message('רכב')],{...first.state,userId:randomUUID()})).rejects.toThrow('state scope');
  await expect(f.run([{...f.message('רכב'),conversation_id:randomUUID()}])).rejects.toThrow('scope');
  await expect(f.run([{...f.message('רכב'),sender_user_id:randomUUID()}])).rejects.toThrow('scope');
  expect(f.occupations).not.toHaveBeenCalled();
});
it('discards an incorrectly returned foreign employee message before providing model context',async()=>{
  const f=fixture();
  await f.run([{...f.message('private foreign salary'),sender_user_id:randomUUID()},f.message('שלום')]);
  expect(JSON.stringify(f.plan.mock.calls)).not.toContain('private foreign salary');
});
it('rejects choosing an occupation without a pending server-side candidate list',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{type:'choose_occupation',candidateKey:developer.key,evidence:'הראשון'}]}));
  await expect(f.run([f.message('הראשון')])).rejects.toThrow('Invalid occupation choice');
});
it('does not accept a model-invented self-reported group without the quoted group value',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[{type:'report_group',value:'ד',evidence:'מפתחת תוכנה'}]}));
  await expect(f.run([f.message('אני מפתחת תוכנה')])).rejects.toThrow('Group lacks source evidence');
  expect(f.search).not.toHaveBeenCalled();
});
