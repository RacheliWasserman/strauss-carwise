import { z } from 'zod';

/**
 * Representative consultation contract, shared by the representative UI, the employee chat and the server.
 * A representative answer is a structured message. It never becomes a financial fact by itself: the employee
 * must choose to use it, the server re-verifies it, and it then waits for approval in the existing summary.
 */
export const REQUESTABLE_FIELDS = {
  base_salary: { label: 'שכר בסיס חודשי ברוטו', question: 'מהו שכר הבסיס החודשי ברוטו?', unit: '₪', min: 1000, max: 1_000_000, integer: false },
  commissions: { label: 'עמלות חודשיות', question: 'מהן העמלות החודשיות?', unit: '₪', min: 0, max: 1_000_000, integer: false },
  bonus: { label: 'בונוס חודשי', question: 'מהו הבונוס החודשי?', unit: '₪', min: 0, max: 1_000_000, integer: false },
  employee_pension_percent: { label: 'הפרשה לפנסיה', question: 'כמה אחוזים מהשכר מנוכים לפנסיה?', unit: '%', min: 0, max: 30, integer: false },
  employee_study_fund_percent: { label: 'הפרשה לקרן השתלמות', question: 'כמה אחוזים מהשכר מנוכים לקרן השתלמות?', unit: '%', min: 0, max: 30, integer: false },
  tax_credit_points: { label: 'נקודות זיכוי', question: 'כמה נקודות זיכוי רשומות?', unit: 'נקודות', min: 0, max: 50, integer: false },
  current_participation: { label: 'השתתפות חודשית ברכב היום', question: 'מהי ההשתתפות החודשית ברכב הצמוד הנוכחי?', unit: '₪', min: 0, max: 100_000, integer: false },
  eligible_children_count: { label: 'ילדים עד גיל 23', question: 'כמה ילדים עד גיל 23 רשומים?', unit: 'ילדים', min: 0, max: 40, integer: true }
} as const;
export type RequestableField = keyof typeof REQUESTABLE_FIELDS;
export const requestableFieldSchema = z.enum(Object.keys(REQUESTABLE_FIELDS) as [RequestableField, ...RequestableField[]]);

/** The request topic names one missing field, readable by people and parseable by the server (max 120 chars). */
export const requestTopic = (field: RequestableField) => `שדה חסר: ${REQUESTABLE_FIELDS[field].label} [${field}]`;
export function fieldFromTopic(topic: string | null | undefined): RequestableField | null {
  const parsed = requestableFieldSchema.safeParse(topic?.match(/\[([a-z_]+)\]\s*$/)?.[1]);
  return parsed.success ? parsed.data : null;
}

export const REP_ANSWER_KIND = 'carwise.rep-answer.v1';
export const repAnswerSchema = z.object({
  kind: z.literal(REP_ANSWER_KIND), requestId: z.string().uuid(), field: requestableFieldSchema,
  value: z.number().finite().nonnegative(), note: z.string().trim().max(300).optional(), answeredAt: z.string().datetime()
}).strict();
export type RepresentativeAnswer = z.infer<typeof repAnswerSchema>;

/** Range check for the representative form; the server checks again when the employee uses the answer. */
export function validateAnswerValue(field: RequestableField, value: number): string | null {
  const spec = REQUESTABLE_FIELDS[field];
  if (!Number.isFinite(value)) return 'יש להזין מספר.';
  if (value < spec.min || value > spec.max) return `הערך צריך להיות בין ${spec.min.toLocaleString('he-IL')} ל־${spec.max.toLocaleString('he-IL')}.`;
  if (spec.integer && !Number.isInteger(value)) return 'יש להזין מספר שלם.';
  return null;
}
export type AnswerableRequest = { id: string; conversation_id: string; status: string; topic: string | null; assigned_representative_id: string | null };
/**
 * Server-side check before a representative's structured answer is stored: only the assigned representative,
 * only while the request is still in their handling (one answer per request), only for the requested field.
 */
export function answerRejection(request: AnswerableRequest | null, answer: RepresentativeAnswer, conversationId: string, representativeId: string): string | null {
  if (!request || request.id !== answer.requestId || request.conversation_id !== conversationId || request.assigned_representative_id !== representativeId) return 'הפנייה הזו לא משויכת אליך.';
  if (request.status === 'answered' || request.status === 'closed') return 'כבר נשלחה תשובה לפנייה הזו.';
  if (request.status !== 'claimed') return 'אפשר לענות רק על פנייה שבטיפולך.';
  if (fieldFromTopic(request.topic) !== answer.field) return 'השדה בתשובה לא תואם לשאלה בפנייה.';
  return validateAnswerValue(answer.field, answer.value);
}
/** The representative's own latest structured answer per request, from their own messages only. */
export function latestOwnAnswers(messages: Array<{ body: string; created_at: string }>, requestIds: string[]) {
  const answers = new Map<string, RepresentativeAnswer>();
  for (const message of [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const answer = decodeRepAnswer(message.body);
    if (answer && requestIds.includes(answer.requestId)) answers.set(answer.requestId, answer);
  }
  return [...answers.values()];
}
export function encodeRepAnswer(answer: RepresentativeAnswer) { return JSON.stringify(repAnswerSchema.parse(answer)); }
export function decodeRepAnswer(body: string): RepresentativeAnswer | null {
  if (!body.startsWith('{') || body.length > 2000) return null;
  try { const parsed = repAnswerSchema.safeParse(JSON.parse(body)); return parsed.success ? parsed.data : null; } catch { return null; }
}
export const formatAnswerValue = (field: RequestableField, value: number) => {
  const unit = REQUESTABLE_FIELDS[field].unit;
  return unit === '₪' ? `${value.toLocaleString('he-IL')} ₪` : unit === '%' ? `${value.toLocaleString('he-IL')}%` : `${value.toLocaleString('he-IL')} ${unit}`;
};
/**
 * A representative's free-text reply to a GENERAL request (no missing field). It names its request, so it is linked to
 * exactly one request, and it is shown to the employee as text only: it never becomes a value or a profile change.
 * Missing-field requests keep the structured answer above (and the employee's approval before any profile update).
 */
export const REP_REPLY_KIND = 'carwise.rep-reply.v1';
export const REP_REPLY_MAX = 2000;
export const repReplySchema = z.object({
  kind: z.literal(REP_REPLY_KIND), requestId: z.string().uuid(), text: z.string().trim().min(1).max(REP_REPLY_MAX),
  answeredAt: z.string().datetime()
}).strict();
export type RepresentativeReply = z.infer<typeof repReplySchema>;
export function encodeRepReply(reply: RepresentativeReply) { return JSON.stringify(repReplySchema.parse(reply)); }
export function decodeRepReply(body: string): RepresentativeReply | null {
  if (!body.startsWith('{') || body.length > REP_REPLY_MAX * 2 + 400) return null;
  try { const parsed = repReplySchema.safeParse(JSON.parse(body)); return parsed.success ? parsed.data : null; } catch { return null; }
}
/** Server-side check before a free-text reply is stored: assigned representative, request in handling, general request only. */
export function replyRejection(request: AnswerableRequest | null, reply: RepresentativeReply, conversationId: string, representativeId: string): string | null {
  if (!request || request.id !== reply.requestId || request.conversation_id !== conversationId || request.assigned_representative_id !== representativeId) return 'הפנייה הזו לא משויכת אליך.';
  if (request.status === 'answered' || request.status === 'closed') return 'כבר נשלחה תשובה לפנייה הזו.';
  if (request.status !== 'claimed') return 'אפשר לענות רק על פנייה שבטיפולך.';
  if (fieldFromTopic(request.topic)) return 'בפנייה הזו חסר שדה מוגדר: יש לענות בטופס המובנה, כדי שהעובד יאשר את הערך לפני שהוא נשמר.';
  return null;
}
/** The representative's own latest free-text reply per request, from their own messages only. */
export function latestOwnReplies(messages: Array<{ body: string; created_at: string }>, requestIds: string[]) {
  const replies = new Map<string, RepresentativeReply>();
  for (const message of [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const reply = decodeRepReply(message.body);
    if (reply && requestIds.includes(reply.requestId)) replies.set(reply.requestId, reply);
  }
  return [...replies.values()];
}
/** The employee's "use this answer" button text. The code is the start of the answer message's own ID. */
export const useAnswerMessage = (messageId: string) => `שימוש בתשובת הנציג #Q${messageId.slice(0, 8).toUpperCase()}`;
