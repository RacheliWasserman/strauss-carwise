import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('../src/lib/supabase-admin',()=>({supabaseAdmin:{}}));
vi.mock('../src/lib/supabase-server',()=>({createSupabaseServerClient:vi.fn()}));
import {runAdvisorTurn,advisorPlanSchema} from '../src/lib/ai/advisor-orchestrator';
import {advisorStateSchema} from '../src/lib/ai/advisor-state';
import {decodeCatalogMessage} from '../src/lib/catalog-message';
import type {EmployeeDataVersionRow} from '../src/lib/employee-data-repository';
import type {CalculationRules} from '../src/lib/rules-repository';
import type {ConversationMessageRow} from '../src/lib/conversation-repository';

function fixture() {
  const user=randomUUID(),conversation=randomUUID(),source=randomUUID();
  const role={key:'a'.repeat(64),title:'מפתח/ת תוכנה',group_code:'ב' as const,car_mandatory:false,waiver_allowed:true,waiver_maintenance_amount:0};
  const rows=[{id:'E-A',display_name:'Fixture Electric',manufacturer_name:'Fixture',group_code:'א' as const,drive_type:'חשמלי'},
    {id:'H-B',display_name:'Fixture Hybrid',manufacturer_name:'Fixture',group_code:'ב' as const,drive_type:'היברידי'}];
  const profile:EmployeeDataVersionRow={id:randomUUID(),user_id:user,version:2,status:'confirmed',schema_version:'employee-data-v1',created_at:new Date().toISOString(),confirmed_at:new Date().toISOString(),
    display_name:'Fixture Person',occupation_title:role.title,base_salary:24680,commissions:0,bonus:0,employee_pension_percent:6,employee_study_fund_percent:2.5,tax_credit_points:2.25,eligible_children_count:0,current_vehicle_id:'H-B',current_participation:500};
  const state=advisorStateSchema.parse({schemaVersion:1,revision:4,userId:user,conversationId:conversation,lastProcessedMessageId:source,
    goal:'catalog',preferences:{},pendingQuestion:null,pendingFacts:[],group:'ב',groupSource:'occupation_match',
    occupation:{reportedTitle:'מפתחת תוכנה',sourceMessageId:source,status:'matched',candidates:[role],match:role,officialRoleVerified:false}});
  const confirmed=vi.fn(async():Promise<EmployeeDataVersionRow|null>=>profile);
  const plan=vi.fn(async()=>advisorPlanSchema.parse({action:'catalog',filters:{}})); // Same bad model label as a live misroute.
  const search=vi.fn(async()=>({vehicles:rows,match:'multiple' as const,hasMore:false,nextCursor:null}));
  const createVersion=vi.fn(),confirmVersion=vi.fn(),snapshot=vi.fn();
  const message=(body:string):ConversationMessageRow=>({id:randomUUID(),conversation_id:conversation,sender_type:'employee',sender_user_id:user,body,created_at:new Date().toISOString(),client_message_id:null});
  const run=(body:string,previous=state)=>runAdvisorTurn(user,conversation,[message(body)],previous,{occupations:async()=>[role],plan,
    catalog:{search,rules:async()=>({version:'fixture',groupOrder:['א','ב','ג','ד'],familyTrack:{minChildren:4,cars:[]}} as unknown as CalculationRules)},
    financial:{confirmed,catalogRows:async()=>rows,createVersion,confirmVersion,snapshot}});
  return {user,profile,state,confirmed,plan,search,createVersion,confirmVersion,snapshot,message,run};
}
it('answers the exact live memory question without catalog cards or a comparison selector',async()=>{
  const f=fixture();const result=await f.run('אתה זוכר את הפרטים שלי?');const reply=decodeCatalogMessage(result.body)!;
  expect(reply.cards).toEqual([]);expect(reply.text).toContain('מאושר');expect(reply.text).toContain(f.profile.occupation_title);
  expect(reply.text).not.toContain('24680');expect(reply.text).not.toContain('איזה מהרכבים');
  expect(f.search).not.toHaveBeenCalled();expect(f.createVersion).not.toHaveBeenCalled();
});
it.each(['מה אתה יודע עליי?','מה התפקיד שלי?','איזה רכב יש לי עכשיו?','אתה זוכר מה אמרתי לך?'])('routes personal recall before a misleading model catalog action: %s',async text=>{
  const f=fixture();const reply=decodeCatalogMessage((await f.run(text)).body)!;
  expect(reply.purpose).toBe('profile_recall');expect(reply.cards).toEqual([]);
  expect(f.confirmed).toHaveBeenCalledWith(f.user);expect(f.plan).not.toHaveBeenCalled();expect(f.search).not.toHaveBeenCalled();
  expect(reply.approval).toBeUndefined();expect(reply.calculation).toBeUndefined();expect(reply.actions).toBeUndefined();
});
it('uses the latest confirmed occupation and car, not pending or stale conversation values',async()=>{
  const f=fixture();f.state.occupation!.match!.title='Stale Role';
  f.state.pendingFacts=[{field:'current_vehicle_id',value:'E-A',status:'pending_confirmation',sourceMessageId:randomUUID()},
    {field:'base_salary',value:99999,status:'pending_confirmation',sourceMessageId:randomUUID()}];
  const reply=decodeCatalogMessage((await f.run('אתה זוכר את הפרטים שלי?')).body)!;
  expect(reply.text).toContain(f.profile.occupation_title);expect(reply.text).toContain('Fixture Hybrid');
  expect(reply.text).not.toContain('Fixture Electric');expect(reply.text).not.toContain('99999');expect(reply.text).not.toContain('24,680');
  expect(reply.text).toContain('טרם אושרו');expect(reply.text).toContain('אינם מחליפים');
});
it('answers naturally when there is no confirmed profile, without promoting pending values',async()=>{
  const f=fixture();f.confirmed.mockResolvedValue(null);
  f.state.pendingFacts=[{field:'base_salary',value:99999,status:'pending_confirmation',sourceMessageId:randomUUID()}];
  const reply=decodeCatalogMessage((await f.run('מה אתה יודע עליי?')).body)!;
  expect(reply.text).toContain('עדיין אין פרופיל');expect(reply.text).toContain('טרם אושרו');expect(reply.text).not.toContain('99999');
  expect(reply.cards).toEqual([]);expect(f.snapshot).not.toHaveBeenCalled();
});
it('reveals confirmed financial fields only on an explicit financial recall request',async()=>{
  const f=fixture();const reply=decodeCatalogMessage((await f.run('מה השכר שלי?')).body)!;
  expect(reply.text).toContain('24,680');expect(reply.text).toContain('ללא חישוב חדש');expect(reply.cards).toEqual([]);
  expect(f.snapshot).not.toHaveBeenCalled();expect(f.confirmVersion).not.toHaveBeenCalled();
});
it('preserves a pending comparison and approval across a side question and reload',async()=>{
  const f=fixture();Object.assign(f.state,{goal:'comparison',activeGoal:{kind:'vehicles',vehicleIds:['E-A','H-B']},goalTracking:1,
    selectedVehicleIds:['E-A','H-B'],pendingQuestion:'approval',pendingApproval:{code:'AABBCCDD',basedOnVersionId:f.profile.id},
    preferences:{driveType:'חשמלי'},shownVehicles:[{id:'E-A',name:'Fixture Electric'}]});
  const before=JSON.parse(JSON.stringify(f.state));
  const result=await f.run('אתה זוכר את הפרטים שלי?');
  for (const key of ['activeGoal','pendingApproval','pendingQuestion','selectedVehicleIds','preferences','shownVehicles'] as const) expect(result.state[key]).toEqual(before[key]);
  const restored=advisorStateSchema.parse(JSON.parse(JSON.stringify(result.state)));
  // The side question did not calculate or consume approval.
  expect(f.snapshot).not.toHaveBeenCalled();expect(restored.pendingApproval?.code).toBe('AABBCCDD');
});
it('resumes vehicle browsing after a memory interlude and state reload without losing filters or occupation',async()=>{
  const f=fixture();f.state.preferences={driveType:'חשמלי'};
  const interlude=await f.run('אתה זוכר את הפרטים שלי?');
  const restored=advisorStateSchema.parse(JSON.parse(JSON.stringify(interlude.state)));
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',intent:'resume',filters:{}}));
  const resumed=await f.run('נמשיך מאיפה שהפסקנו',restored);
  expect(resumed.state.occupation?.match).toEqual(f.state.occupation?.match);
  expect(resumed.state.preferences.driveType).toBe('חשמלי');
  expect(decodeCatalogMessage(resumed.body)?.cards.map(card=>card.id)).toEqual(['E-A']);
  expect(f.createVersion).not.toHaveBeenCalled();expect(f.confirmVersion).not.toHaveBeenCalled();
});
it('protects against a mismatched profile owner and repository errors without leaking data',async()=>{
  const f=fixture();f.confirmed.mockResolvedValue({...f.profile,user_id:randomUUID(),occupation_title:'OTHER PRIVATE ROLE'});
  const reply=decodeCatalogMessage((await f.run('מה התפקיד שלי?')).body)!;
  expect(reply.text).toContain('לא הצלחתי לטעון');expect(reply.text).not.toContain('OTHER PRIVATE ROLE');expect(reply.cards).toEqual([]);
  f.confirmed.mockRejectedValue(new Error('private secret'));
  expect((await f.run('מה אתה יודע עליי?')).body).not.toContain('private secret');
});
it('honors a structured recall intent even for wording outside the deterministic question guard',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',intent:'profile_recall',recallTopic:'occupation',filters:{}}));
  const reply=decodeCatalogMessage((await f.run('אשמח לתזכורת לגבי המקצוע שרשום אצלכם')).body)!;
  expect(reply.purpose).toBe('profile_recall');expect(reply.text).toContain(f.profile.occupation_title);expect(f.search).not.toHaveBeenCalled();
});
it('answers a hypothetical occupation question without applying real occupation operations',async()=>{
  const f=fixture();f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',intent:'hypothetical',filters:{},operations:[
    {type:'report_occupation',reportedTitle:'מנהלת אחרת',candidateKeys:[],certainty:'uncertain',evidence:'מנהלת אחרת'}]}));
  const result=await f.run('מה אם הייתי מנהלת אחרת?');
  expect(result.state.occupation).toEqual(f.state.occupation);expect(result.state.pendingFacts).toEqual(f.state.pendingFacts);
  const reply=decodeCatalogMessage(result.body)!;expect(reply.purpose).toBe('hypothetical');expect(reply.cards).toEqual([]);expect(f.createVersion).not.toHaveBeenCalled();
});
it('does not render old cards or advance a calculation for a structured conversational side question',async()=>{
  const f=fixture();Object.assign(f.state,{goal:'net',activeGoal:{kind:'vehicles',vehicleIds:['E-A']},goalTracking:1,selectedVehicleIds:['E-A'],pendingQuestion:'financial',pendingField:'base_salary'});
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',intent:'conversation',filters:{}}));
  const result=await f.run('אפשר להסביר איך השירות הזה עובד?');const reply=decodeCatalogMessage(result.body)!;
  expect(reply.cards).toEqual([]);expect(result.state.pendingField).toBe('base_salary');expect(f.snapshot).not.toHaveBeenCalled();expect(f.search).not.toHaveBeenCalled();
});
