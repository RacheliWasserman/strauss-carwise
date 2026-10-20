import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('../src/lib/supabase-admin',()=>({supabaseAdmin:{}}));
vi.mock('../src/lib/supabase-server',()=>({createSupabaseServerClient:vi.fn()}));
const google=vi.hoisted(()=>({generate:vi.fn()}));
vi.mock('@google/genai',()=>({GoogleGenAI:class {models={generateContent:google.generate};}}));
import {configuredProviders,generateValidatedReply,InvalidProviderOutput,ProviderFailure} from '../src/lib/ai/providers';
import {validateAdvisorPlan,understandAdvisorTurn,advisorPlanSchema} from '../src/lib/ai/advisor-orchestrator';
import type {AdvisorState} from '../src/lib/ai/advisor-state';
import type {ConversationMessageRow} from '../src/lib/conversation-repository';
import type {AdvisorOccupation} from '../src/lib/occupation-repository';
const user=randomUUID(),conversation=randomUUID(),id=randomUUID();
const message:ConversationMessageRow={id,conversation_id:conversation,sender_user_id:user,sender_type:'employee',body:'אני מפתחת תוכנה ומחפשת רכב חשמלי',created_at:new Date().toISOString(),client_message_id:null};
const state:AdvisorState={schemaVersion:1,revision:1,userId:user,conversationId:conversation,lastProcessedMessageId:id,goal:'catalog',preferences:{},pendingQuestion:null,pendingFacts:[]};
const occupations:AdvisorOccupation[]=[{key:'a'.repeat(64),title:'מפתח/ת תוכנה',group_code:'ב',car_mandatory:false,waiver_allowed:true,waiver_maintenance_amount:1000}];
const valid=JSON.stringify({action:'catalog',filters:{},operations:[{type:'report_occupation',reportedTitle:'מפתחת תוכנה',evidence:'מפתחת תוכנה',candidateKeys:[occupations[0].key],certainty:'clear'},{type:'set_preference',field:'driveType',value:'חשמלי',evidence:'רכב חשמלי'}]});
const validate=(raw:string)=>validateAdvisorPlan(raw,[message],occupations,state);
const compatible=(text:string)=>new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
beforeEach(()=>{
  vi.resetAllMocks();vi.stubEnv('GEMINI_API_KEY','offline-primary');vi.stubEnv('GROQ_API_KEY','offline-backup');vi.stubEnv('OPENROUTER_API_KEY','offline-final');
  vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'info').mockImplementation(()=>{});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});

it.each([
  ['malformed JSON','{"private-sensitive-value":','invalid_json'],
  ['wrong schema',JSON.stringify({action:'catalog',filters:{},operations:'private-sensitive-value'}),'invalid_plan'],
  ['unknown occupation',valid.replace('a'.repeat(64),'b'.repeat(64)),'invalid_plan_reference'],
  ['missing evidence',valid.replaceAll('מפתחת תוכנה','private-sensitive-value'),'invalid_plan_evidence'],
  ['oversized output',valid+' '.repeat(6001),'output_too_large']
])('recovers from %s through the next provider without accepting the invalid plan',async(_name,invalid,reason)=>{
  const first=vi.fn(async()=>invalid),second=vi.fn(async()=>valid);
  expect((await generateValidatedReply([{role:'user',content:message.body}],[{name:'gemini',generate:first},{name:'groq',generate:second}],validate)).operations).toHaveLength(2);
  expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith('[carwise.ai.provider]',expect.objectContaining({provider:'gemini',reason,phase:'validation',fallbackUsed:true,status:200,durationMs:expect.any(Number)}));
  expect(console.info).toHaveBeenCalledWith('[carwise.ai.provider.result]',expect.objectContaining({provider:'groq',usedFallback:true}));
  const logs=JSON.stringify([...vi.mocked(console.warn).mock.calls,...vi.mocked(console.info).mock.calls]);
  expect(logs).not.toContain('private-sensitive-value');expect(logs).not.toContain(message.body);expect(logs).not.toContain(user);
  expect(state.preferences).toEqual({}); // No partial business state was committed.
});
it('uses Gemini then Groq then OpenRouter when both first outputs are invalid',async()=>{
  google.generate.mockResolvedValue({text:'not JSON',candidates:[{finishReason:'STOP'}]});
  const transport=vi.fn().mockResolvedValueOnce(compatible('{"wrong":true}')).mockResolvedValueOnce(compatible(valid));vi.stubGlobal('fetch',transport);
  const plan=await understandAdvisorTurn([message],occupations,state);
  expect(plan.operations).toHaveLength(2);expect(google.generate).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls.map(call=>call[0])).toEqual(['https://api.groq.com/openai/v1/chat/completions','https://openrouter.ai/api/v1/chat/completions']);
  const primary=google.generate.mock.calls[0][0];
  expect(primary.config.systemInstruction).toContain('"set_preference"');
  expect(primary.config.systemInstruction).toContain('"additionalProperties":false');
  for (const [,options] of transport.mock.calls) {
    const body=JSON.parse(options.body);expect(body.messages[0].content).toBe(primary.config.systemInstruction);
    expect(body.messages.slice(1)).toEqual([{role:'user',content:message.body}]);
    expect(body.tools).toBeUndefined(); // Protocol is validated JSON text, not unsupported native tool calls.
  }
});
it.each(['MAX_TOKENS','length'])('does not accept a potentially truncated structured plan (%s)',async reason=>{
  if (reason==='MAX_TOKENS') {
    google.generate.mockResolvedValue({text:valid,candidates:[{finishReason:reason}]});
    vi.stubGlobal('fetch',vi.fn(async()=>compatible(valid)));
  } else {
    google.generate.mockRejectedValue({status:504});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:valid},finish_reason:'length'}]}))).mockResolvedValueOnce(compatible(valid)));
  }
  expect((await understandAdvisorTurn([message],occupations,state)).action).toBe('catalog');
  expect(console.warn).toHaveBeenCalledWith('[carwise.ai.provider]',expect.objectContaining({reason:'truncated_output',fallbackUsed:true}));
});
it('recovers from the configured Gemini timeout, without changing the 20-second deadline',async()=>{
  vi.useFakeTimers();google.generate.mockReturnValue(new Promise(()=>{}));
  const transport=vi.fn(async()=>compatible(valid));vi.stubGlobal('fetch',transport);
  const result=understandAdvisorTurn([message],occupations,state);
  await vi.waitFor(()=>expect(google.generate).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(20000);
  expect((await result).action).toBe('catalog');expect(transport).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith('[carwise.ai.provider]',expect.objectContaining({reason:'timeout',fallbackUsed:true,durationMs:expect.any(Number)}));
});
it('returns a classified failure when all providers produce invalid JSON',async()=>{
  google.generate.mockResolvedValue({text:'broken'});const transport=vi.fn(async()=>compatible('broken'));vi.stubGlobal('fetch',transport);
  await expect(understandAdvisorTurn([message],occupations,state)).rejects.toMatchObject({retryable:true,reason:'invalid_json'});
  expect(transport).toHaveBeenCalledTimes(2);
  expect(console.warn).toHaveBeenLastCalledWith('[carwise.ai.provider]',expect.objectContaining({provider:'openrouter',fallbackUsed:false}));
});
it.each([400,401,403])('continues past a provider-specific HTTP %s to the last provider',async status=>{
  const last=vi.fn(async()=>valid);
  const plan=await generateValidatedReply([{role:'user',content:message.body}],[
    {name:'gemini',generate:async()=>'{invalid'},
    {name:'groq',generate:async()=>{throw new ProviderFailure(false,'invalid_request',status);}},
    {name:'openrouter',generate:last}
  ],validate);
  expect(plan.operations).toHaveLength(2);expect(last).toHaveBeenCalledTimes(1);
});
it('treats null for an optional field as absent, and still rejects null for a required one',()=>{
  const withNulls=JSON.stringify({action:'catalog',filters:null,goal:null,operations:[{type:'report_occupation',reportedTitle:'מפתחת תוכנה',evidence:'מפתחת תוכנה',
    candidateKeys:[occupations[0].key],certainty:'clear'}]});
  expect(validate(withNulls).operations).toHaveLength(1);
  expect(()=>validate(JSON.stringify({action:null,filters:{},operations:[]}))).toThrow(InvalidProviderOutput);
  expect(()=>validate(JSON.stringify({action:'catalog',operations:[{type:'new_search',evidence:null}]}))).toThrow(InvalidProviderOutput);
});
it('does not hide an unexpected local validator bug with automatic fallback',async()=>{
  const next=vi.fn(async()=>valid);
  await expect(generateValidatedReply([{role:'user',content:'fixture'}],[{name:'gemini',generate:async()=>valid},{name:'groq',generate:next}],()=>{throw new TypeError('private local data');})).rejects.toMatchObject({retryable:false,reason:'internal_error'});
  expect(next).not.toHaveBeenCalled();expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private local data');
});
it('does not reinterpret a safety block as recoverable truncation',async()=>{
  google.generate.mockResolvedValue({text:valid,candidates:[{finishReason:'MAX_TOKENS'}],promptFeedback:{blockReason:'SAFETY'}});
  const transport=vi.fn();vi.stubGlobal('fetch',transport);
  await expect(understandAdvisorTurn([message],occupations,state)).rejects.toMatchObject({retryable:false,reason:'safety_or_unsupported_output'});
  expect(transport).not.toHaveBeenCalled();
});
it('does not bypass unsupported tool calls merely because a compatible response reached its length limit',async()=>{
  google.generate.mockRejectedValue({status:504});
  const transport=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:valid,tool_calls:[{}]}}]})));vi.stubGlobal('fetch',transport);
  await expect(understandAdvisorTurn([message],occupations,state)).rejects.toMatchObject({retryable:false,reason:'safety_or_unsupported_output'});
  expect(transport).toHaveBeenCalledTimes(1);
});
it('does not weaken strict schemas to accommodate model output',()=>{
  expect(()=>validate(JSON.stringify({action:'catalog',filters:{},operations:[],madeUpGroup:'ד'}))).toThrow(InvalidProviderOutput);
  expect(advisorPlanSchema.safeParse({action:'catalog',filters:{},operations:[{type:'set_preference',field:'group',value:'invented',evidence:'רכב'}]}).success).toBe(true);
  expect(()=>validate(JSON.stringify({action:'catalog',filters:{},operations:[{type:'set_preference',field:'group',value:'invented',evidence:'רכב'}]}))).toThrow(InvalidProviderOutput);
});
