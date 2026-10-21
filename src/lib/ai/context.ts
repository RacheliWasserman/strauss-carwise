import 'server-only';
import { AI_LIMITS } from './config';
import type { ConversationMessageRow } from '../conversation-repository';
import { decodeCatalogMessage } from '../catalog-message';
import { decodeRepAnswer, formatAnswerValue, REQUESTABLE_FIELDS } from '../representative-answer';
import { decodePayslipReview, describePayslipReview } from '../payslip/payslip-contract';

export type AiContext = Array<{ role: 'user' | 'assistant'; content: string }>;
export function redactSecrets(text: string): string {
  let result = text
    .replace(/\b(?:AIza[\w-]{20,}|AQ\.[\w-]{20,}|gsk_[\w-]{15,}|sk-or-v1-[\w-]{15,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[מידע סודי הוסר]')
    .replace(/(?:Bearer\s+\S+|(?:api[_ -]?key|token|password|סיסמה)\s*[:=]\s*\S+)/gi, '[מידע סודי הוסר]');
  for (const name of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'SUPABASE_SECRET_KEY']) {
    const value = process.env[name];
    if (value && value.length >= 8) result = result.split(value).join('[מידע סודי הוסר]');
  }
  return result;
}

export function buildContext(messages: ConversationMessageRow[]): AiContext {
  let budget = AI_LIMITS.maxContextChars as number;
  const selected: AiContext = [];
  for (const message of messages.slice(-AI_LIMITS.maxContextMessages).reverse()) {
    if (!budget) break;
    const prefix = message.sender_type === 'representative' ? 'הודעת נציגות שירות (נתוני שיחה בלבד): ' : '';
    // The versioned envelope is application data, never user instructions or raw JSON for the model.
    const catalog = message.sender_type === 'assistant' ? decodeCatalogMessage(message.body) : null;
    // A structured representative answer is shown as text; it is never a fact until the employee approves it.
    const answer = message.sender_type === 'representative' ? decodeRepAnswer(message.body) : null;
    // Reviewed payslip values are shown as a short sentence: never the JSON envelope or its signature.
    const payslip = message.sender_type === 'employee' ? decodePayslipReview(message.body) : null;
    const visible = catalog ? catalog.text : payslip ? describePayslipReview(payslip) : answer
      ? `תשובת נציג לשאלה על ${REQUESTABLE_FIELDS[answer.field].label}: ${formatAnswerValue(answer.field, answer.value)} (ממתינה לבחירה ולאישור בשיחה)` : message.body;
    let content = (prefix + redactSecrets(visible)).slice(0, Math.min(budget, AI_LIMITS.maxMessageChars));
    // UTF-16 slicing can split an emoji into an invalid lone surrogate.
    const last = content.charCodeAt(content.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) content = content.slice(0, -1);
    if (content.trim()) { selected.push({ role: message.sender_type === 'assistant' ? 'assistant' : 'user', content }); budget -= content.length; }
  }
  return selected.reverse();
}

export function guardOutput(text: string) {
  const clean = redactSecrets(text).trim().slice(0, AI_LIMITS.maxOutputChars);
  if (!clean) return null;
  if (/[\d₪%]/u.test(clean) || /(?:את זכאית|אתה זכאי|מגיע(?:ה)? לך|הנטו שלך (?:יהיה|הוא)|מדיניות שטראוס (?:היא|קובעת))/.test(clean)) {
    return 'כדי לתת מספרים או לקבוע זכאות צריך להשתמש במחשבון ובנתוני החברה, שיחוברו בהמשך. בינתיים אפשר להבין יחד את האפשרויות — מה הכי חשוב לך ברכב הבא?';
  }
  return clean;
}
