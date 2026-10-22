import { expect, it } from 'vitest';
import { conversationReply } from '../src/lib/ai/conversation-reply';
import { encodeCatalogMessage, type CatalogMessage } from '../src/lib/catalog-message';
import type { ConversationMessageRow } from '../src/lib/conversation-repository';

const scenario = {kind:'vehicle' as const,vehicleId:'fixture-car',name:'רכב בדיקה',group_code:'ב',drive_type:'חשמלי',eligible:true,reason:'מתאים לקבוצה שנבדקה',
  net:16000,delta:-250,participation:1000,carValueOfUse:2000,electricGrossUp:0,maintenance:0,familyExtra:0,incomeTax:3000};
const reply:CatalogMessage={kind:'carwise.catalog.v1',text:'הנה ההשוואה לפי הנתונים שאושרו.',cards:[],recordedAt:'2026-10-22T00:00:00.000Z',
  state:{awaitingGroup:false,filters:{}},calculation:{runId:null,saved:false,profileVersion:1,rulesVersion:'test',taxYear:2026,
    baseline:{...scenario,net:16250,delta:0},scenarios:[scenario]}};
const message=(value:CatalogMessage)=>({sender_type:'assistant',body:encodeCatalogMessage(value)} as ConversationMessageRow);

it('annualizes only existing deterministic results, even after a thank-you interlude',()=>{
  const history=[message(reply),message({...reply,purpose:'conversation',text:'בשמחה!',calculation:undefined})];
  const output=conversationReply('annual',history);
  expect(output).toContain('192,000');expect(output).toContain('-3,000');expect(output).toContain('לא חישוב מס שנתי');
  expect(reply.calculation?.scenarios[0].net).toBe(16000);
});
it('never invents an annual result when no calculation exists',()=>{
  expect(conversationReply('annual',[])).toContain('עדיין אין');
  expect(conversationReply('annual',[])).not.toMatch(/[\d₪]/);
});
it('does not calculate from ineligible or incomplete scenarios',()=>{
  const incomplete={...reply,calculation:{...reply.calculation!,scenarios:[{...scenario,eligible:false,net:null,delta:null}]}};
  expect(conversationReply('annual',[message(incomplete)])).toContain('אין בחישוב האחרון תוצאה מלאה');
});
it('explains only saved results and states the comparison baseline',()=>{
  const output=conversationReply('clarify',[message(reply)]);
  expect(output).toContain('16,000');expect(output).toContain('-250');expect(output).toContain('למצב הקיים');
});
it('asks about the pending field instead of restarting the vehicle search',()=>{
  expect(conversationReply('clarify',[],'אחוז הפנסיה')).toContain('אחוז הפנסיה');
  expect(conversationReply('clarify',[],'אחוז הפנסיה')).not.toContain('איזה רכב');
});
