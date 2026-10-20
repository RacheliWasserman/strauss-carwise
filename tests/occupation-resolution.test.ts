import {createHash,randomUUID} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('../src/lib/supabase-admin',()=>({supabaseAdmin:{}}));
vi.mock('../src/lib/supabase-server',()=>({createSupabaseServerClient:vi.fn()}));
vi.mock('../src/lib/employee-data-repository',()=>({createEmployeeDataVersion:vi.fn(),getLatestConfirmedEmployeeData:vi.fn(async()=>null)}));
import officialTable from '../data/occupations.json';
import {detectOccupation} from '../src/lib/ai/occupation-matcher';
import {runAdvisorTurn,advisorPlanSchema,validateAdvisorPlan} from '../src/lib/ai/advisor-orchestrator';
import {InvalidProviderOutput} from '../src/lib/ai/providers';
import type {AdvisorState} from '../src/lib/ai/advisor-state';
import {decodeCatalogMessage} from '../src/lib/catalog-message';
import type {AdvisorOccupation} from '../src/lib/occupation-repository';
import type {CalculationRules} from '../src/lib/rules-repository';
import type {ConversationMessageRow} from '../src/lib/conversation-repository';

// The challenge's official 14-row table, shaped like the occupations repository output.
const official:AdvisorOccupation[]=(officialTable as Array<Record<string,string|number>>).map(row=>({
  title:String(row['עיסוק']),group_code:row['קבוצת זכאות'] as AdvisorOccupation['group_code'],
  car_mandatory:row['רכב חובה']==='כן',waiver_allowed:row['מותר לוותר']==='כן',
  waiver_maintenance_amount:Number(row['אחזקת רכב בוויתור (₪)']),key:createHash('sha256').update(String(row['עיסוק'])).digest('hex')
})).sort((a,b)=>a.title.localeCompare(b.title));
const byTitle=(title:string)=>official.find(row=>row.title===title)!;
const developer=byTitle('מפתח/ת תוכנה');
const titles=(text:string,partial=false)=>detectOccupation(text,official,{partial})?.rows.map(row=>row.title);

beforeEach(()=>{vi.spyOn(console,'info').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});});

it.each([
  ['אני מפתחת תוכנה ומחפשת רכב חשמלי','מפתח/ת תוכנה'],
  ['מפתחת תוכנה','מפתח/ת תוכנה'],
  ['מפתח תוכנה','מפתח/ת תוכנה'],
  ['מפתח/ת תוכנה','מפתח/ת תוכנה'],
  ['אני עובדת כמפתחת תוכנה בחברה','מפתח/ת תוכנה'],
  ['אני נציגת מכירות בשטח','נציג/ת מכירות שטח'],
  ['אנליסטית נתונים','אנליסט/ית נתונים'],
  ['אני מפקחת איכות במפעל','מפקח/ת איכות במפעל'],
  ['רכזת רכש','רכז/ת רכש'],
  ['נהגת הפצה','נהג/ת הפצה'],
  ['אני טכנאית שירות','טכנאי/ת שירות'],
  ['אני מנהלת מחלקת שיווק','מנהל/ת מחלקה'],
  ['מנהלת אזור מכירות','מנהל/ת אזור מכירות']
])('matches "%s" to the official title %s using generic Hebrew forms',(text,title)=>{
  const result=detectOccupation(text,official);
  expect(result?.exact).toBe(true);expect(result?.rows.map(row=>row.title)).toEqual([title]);
  expect(text).toContain(result!.phrase);
});
it('matches every official title in masculine and feminine form to itself only',()=>{
  for (const row of official) {
    const masculine=row.title.replace(/\/\S+/gu,''),feminine=row.title.replace(/\/(\S+)/gu,'$1');
    expect(titles(masculine)).toEqual([row.title]);expect(titles(feminine)).toEqual([row.title]);
  }
});
it.each(['אני מחפשת רכב חשמלי','בעצם אני רוצה היברידי','כמה זה ישפיע לי על הנטו?','שלום','הראשון'])(
  'does not invent an occupation from "%s"',text=>{expect(detectOccupation(text,official,{partial:true})).toBeNull();});
it('offers partial candidates only for an explicit answer and never as a decided match',()=>{
  expect(titles('אני עובדת בפיתוח תוכנה')).toBeUndefined();
  expect(titles('אני עובדת בפיתוח תוכנה',true)?.sort()).toEqual(['מנהל/ת פיתוח','מפתח/ת תוכנה'].sort());
  expect(detectOccupation('אני עובדת בפיתוח תוכנה',official,{partial:true})?.exact).toBe(false);
  expect(detectOccupation('אני מנהלת',official,{partial:true})).toBeNull(); // Too vague for a 5-option question.
});

function fixture(rows:AdvisorOccupation[]=official) {
  const user=randomUUID(),conversation=randomUUID();
  const message=(body:string):ConversationMessageRow=>({id:randomUUID(),conversation_id:conversation,sender_type:'employee',sender_user_id:user,body,client_message_id:null,created_at:new Date().toISOString()});
  const assistant=(body:string):ConversationMessageRow=>({...message(body),sender_type:'assistant',sender_user_id:null});
  const occupations=vi.fn(async()=>rows);
  const plan=vi.fn(async()=>advisorPlanSchema.parse({action:'catalog',filters:{}}));
  const vehicle=(id:string,group_code:'א'|'ב'|'ג',drive_type:string)=>({id,display_name:id,manufacturer_name:'Fixture',group_code,drive_type});
  const search=vi.fn(async(_input:unknown)=>({vehicles:[vehicle('CAR-03','א','חשמלי'),vehicle('CAR-06','ב','חשמלי'),vehicle('CAR-08','ב','חשמלי'),
    vehicle('CAR-10','ג','חשמלי'),vehicle('CAR-02','א','היברידי'),vehicle('CAR-05','ב','היברידי'),vehicle('CAR-09','ג','היברידי'),vehicle('CAR-01','א','בנזין')],
    match:'multiple' as const,hasMore:false,nextCursor:null}));
  const rules=vi.fn(async()=>({version:'fixture-v1',groupOrder:['א','ב','ג','ד'],familyTrack:{minChildren:4,cars:[]}} as unknown as CalculationRules));
  const run=(messages:ConversationMessageRow[],previous:AdvisorState|null=null)=>runAdvisorTurn(user,conversation,messages,previous,{occupations,plan,catalog:{search,rules}});
  return {user,conversation,message,assistant,occupations,plan,search,run};
}
const cards=(body:string)=>decodeCatalogMessage(body)?.cards.map(card=>card.id);
const text=(body:string)=>decodeCatalogMessage(body)!.text;

it('REGRESSION: resolves occupation and electric preference from the first message when the model omits report_occupation',async()=>{
  const f=fixture();
  // The live model returned a catalog plan without the occupation operation.
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{driveType:'חשמלי'}}));
  const first=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי')]);
  expect(first.state.occupation?.match).toEqual(developer);
  expect(first.state.group).toBe('ב');expect(first.state.groupSource).toBe('occupation_match');
  expect(first.state.pendingQuestion).toBeNull();
  expect(cards(first.body)).toEqual(['CAR-03','CAR-06','CAR-08']);
  expect(text(first.body)).not.toContain('מה העיסוק');expect(text(first.body)).toContain('בשמחה');expect(text(first.body)).not.toMatch(/קבוצה [אבגד]|טבלת|אימות רשמי|התאמתי את העיסוק/);
  // Change of preference after reload keeps occupation and group.
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{}}));
  const restored=JSON.parse(JSON.stringify(first.state));
  const hybrid=await f.run([f.message('בעצם אני רוצה היברידי')],restored);
  expect(hybrid.state.group).toBe('ב');expect(hybrid.state.occupation?.match?.title).toBe('מפתח/ת תוכנה');
  expect(cards(hybrid.body)).toEqual(['CAR-02','CAR-05']);
  expect(text(hybrid.body)).not.toContain('מה העיסוק');
});
it('REGRESSION: an explicit occupation answer with empty model candidates is matched to the official record',async()=>{
  const f=fixture();
  const asked=await f.run([f.message('אני מחפשת רכב חשמלי')]);
  expect(asked.state.pendingQuestion).toBe('occupation');
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[
    {type:'report_occupation',reportedTitle:'מפתחת תוכנה',evidence:'מפתחת תוכנה',candidateKeys:[],certainty:'uncertain'}]}));
  const answer=await f.run([f.message('מפתחת תוכנה')],asked.state);
  expect(answer.state.occupation?.status).toBe('matched');expect(answer.state.group).toBe('ב');
  expect(cards(answer.body)).toEqual(['CAR-03','CAR-06','CAR-08']);
  expect(text(answer.body)).not.toContain('לא מצאתי התאמה');
});
it('REGRESSION: repairs a conversation already stuck in the live failure state on the next turn',async()=>{
  const f=fixture();
  const original=f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי'),answer=f.message('מפתחת תוכנה');
  const stuck:AdvisorState={schemaVersion:1,revision:2,userId:f.user,conversationId:f.conversation,lastProcessedMessageId:answer.id,
    goal:'catalog',preferences:{driveType:'חשמלי'},pendingQuestion:'representative',pendingFacts:[],
    occupation:{reportedTitle:'מפתחת תוכנה',sourceMessageId:answer.id,status:'no_match',candidates:[],officialRoleVerified:false}};
  const next=await f.run([original,f.assistant('שאלה'),answer,f.assistant('לא מצאתי'),f.message('אפשר לראות רכבים?')],stuck);
  expect(next.state.occupation?.match?.title).toBe('מפתח/ת תוכנה');expect(next.state.group).toBe('ב');
  expect(cards(next.body)).toEqual(['CAR-03','CAR-06','CAR-08']);
});
it('recovers the occupation from an earlier own message when that turn produced no business state',async()=>{
  const f=fixture();
  const next=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי'),f.message('נו?')]);
  expect(next.state.group).toBe('ב');expect(cards(next.body)).toEqual(['CAR-03','CAR-06','CAR-08']);
});
it('does not revive an older occupation statement after the employee replaced it',async()=>{
  const f=fixture();
  const older=f.message('אני מפתחת תוכנה'),replaced=f.message('בעצם אני טכנאית שירות');
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{}}));
  const first=await f.run([older,replaced]);
  expect(first.state.occupation?.match?.title).toBe('טכנאי/ת שירות');
  const next=await f.run([older,replaced,f.message('ומה עם חשמלי?')],first.state);
  expect(next.state.group).toBe('א');expect(cards(next.body)).toEqual(['CAR-03']);
});
it('asks one clarification for a partial explicit answer instead of declaring no match',async()=>{
  const f=fixture();
  const asked=await f.run([f.message('אני מחפשת רכב חשמלי')]);
  const answer=await f.run([f.message('אני עובדת בפיתוח תוכנה')],asked.state);
  expect(answer.state.pendingQuestion).toBe('occupation_choice');expect(answer.state.group).toBeUndefined();
  expect(text(answer.body)).toContain('מפתח/ת תוכנה');expect(text(answer.body)).toContain('מנהל/ת פיתוח');
  expect(f.search).not.toHaveBeenCalled();
});
it('treats a conflicting clear model match and server match as ambiguous, never picking one silently',async()=>{
  const f=fixture();
  f.plan.mockResolvedValue(advisorPlanSchema.parse({action:'catalog',filters:{},operations:[
    {type:'report_occupation',reportedTitle:'מפתחת תוכנה',evidence:'מפתחת תוכנה',candidateKeys:[byTitle('מנהל/ת פיתוח').key],certainty:'clear'}]}));
  const result=await f.run([f.message('אני מפתחת תוכנה')]);
  expect(result.state.occupation?.status).toBe('ambiguous');expect(result.state.group).toBeUndefined();
  expect(f.search).not.toHaveBeenCalled();
});
it('reports an empty (RLS-hidden) occupation list as unavailable, not as "no match", and never guesses',async()=>{
  const f=fixture([]);
  const result=await f.run([f.message('אני מפתחת תוכנה ומחפשת רכב חשמלי')]);
  expect(result.state.group).toBeUndefined();expect(f.search).not.toHaveBeenCalled();
  expect(text(result.body)).toContain('לא זמינה');expect(text(result.body)).not.toContain('לא מצאתי התאמה');
  expect(console.warn).toHaveBeenCalledWith('[carwise.ai.advisor]',expect.objectContaining({phase:'occupations',outcome:'empty'}));
});
it('accepts short model refs only when they exist in this request\'s official list',()=>{
  const f=fixture();const latest=f.message('אני מפתחת תוכנה');
  const state:AdvisorState={schemaVersion:1,revision:1,userId:f.user,conversationId:f.conversation,lastProcessedMessageId:latest.id,goal:'catalog',preferences:{},pendingQuestion:null,pendingFacts:[]};
  const ref=`O${official.indexOf(developer)+1}`;
  const raw=(key:string)=>JSON.stringify({action:'catalog',filters:{},operations:[{type:'report_occupation',reportedTitle:'מפתחת תוכנה',evidence:'מפתחת תוכנה',candidateKeys:[key],certainty:'clear'}]});
  const plan=validateAdvisorPlan(raw(ref),[latest],official,state);
  expect(plan.operations[0]).toMatchObject({candidateKeys:[developer.key]});
  expect(()=>validateAdvisorPlan(raw('O99'),[latest],official,state)).toThrow(InvalidProviderOutput);
});
