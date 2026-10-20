import { z } from 'zod';

const uuid = z.string().uuid();
export const conversationSchema = z.object({
  id: uuid, owner_user_id: uuid, title: z.string().nullable(), status: z.literal('open'),
  created_at: z.string(), updated_at: z.string(), last_message_at: z.string()
});
export const chatMessageSchema = z.object({
  id: uuid, conversation_id: uuid,
  sender_type: z.enum(['employee', 'assistant', 'representative']),
  sender_user_id: uuid.nullable(), body: z.string(),
  client_message_id: uuid.nullable(), created_at: z.string()
});
const cursorSchema = z.object({ before: z.string(), beforeId: uuid });
export type ChatConversation = z.infer<typeof conversationSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCursor = z.infer<typeof cursorSchema>;
export const outgoingSchema = z.object({
  requestId: uuid, conversationId: uuid.nullable(), body: z.string().trim().min(1).max(16000)
});
export type OutgoingMessage = z.infer<typeof outgoingSchema>;

export class ChatApiError extends Error {
  constructor(public status: number, public code?: string) {
    super(status === 401 ? 'כדי להמשיך, צריך להתחבר שוב לחשבון.'
      : status === 404 ? 'לא הצלחנו לפתוח את השיחה הזו. אפשר לנסות שוב או לבחור שיחה אחרת.'
      : status === 409 ? 'לא ניתן לשמור את ההודעה עם המזהה הקיים. נסי לטעון שוב את השיחה.'
      : 'לא הצלחנו להשלים את הפעולה. בדקי את החיבור ונסי שוב.');
  }
}

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      let code: string | undefined;
      try { const data = await response.json(); if (typeof data.code === 'string' && /^AI_[A-Z_]+$/.test(data.code)) code = data.code; } catch { /* No raw provider errors. */ }
      throw new ChatApiError(response.status, code);
    }
    return schema.parse(await response.json());
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (error instanceof ChatApiError) throw error;
    // A timeout or malformed success can still mean the write committed.
    throw new ChatApiError(0);
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

function pagePath(path: string, cursor: ChatCursor | null) {
  const query = new URLSearchParams({ limit: '30' });
  if (cursor) { query.set('before', cursor.before); query.set('beforeId', cursor.beforeId); }
  return `${path}?${query}`;
}
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const chatApi = {
  list: (cursor: ChatCursor | null = null, signal?: AbortSignal) => request(
    pagePath('/api/conversations', cursor),
    z.object({ conversations: z.array(conversationSchema), nextCursor: cursorSchema.nullable() }), { signal }
  ),
  conversation: (id: string, signal?: AbortSignal) => request(
    `/api/conversations/${uuid.parse(id)}`, z.object({ conversation: conversationSchema }), { signal }
  ),
  messages: (id: string, cursor: ChatCursor | null = null, signal?: AbortSignal) => request(
    pagePath(`/api/conversations/${uuid.parse(id)}/messages`, cursor),
    z.object({ messages: z.array(chatMessageSchema), nextCursor: cursorSchema.nullable() }), { signal }
  ),
  create: (operation: OutgoingMessage) => request('/api/conversations', z.object({ conversationId: uuid }),
    post({ body: operation.body, clientRequestId: operation.requestId })),
  assistant: (id: string, messageId: string, statusOnly = false, signal?: AbortSignal) => request(
    `/api/conversations/${uuid.parse(id)}/assistant`,
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('complete'), message: chatMessageSchema }),
      z.object({ status: z.literal('pending') })
    ]), { ...post({ messageId: uuid.parse(messageId), statusOnly }), signal }, 50000
  ),
  send: (operation: OutgoingMessage) => request(
    `/api/conversations/${uuid.parse(operation.conversationId)}/messages`,
    z.object({ message: chatMessageSchema }),
    post({ body: operation.body, clientMessageId: operation.requestId })
  )
};

export type DeliveryResult = { conversationId: string; message?: ChatMessage };

// A synchronous lock closes the gap before React renders the disabled send button.
// Failed/ambiguous writes keep their original operation and key until retried.
export class ChatDelivery {
  private pending: OutgoingMessage | null = null;
  private inFlight: Promise<DeliveryResult> | null = null;
  constructor(private transport = chatApi) {}

  deliver(input: OutgoingMessage): Promise<DeliveryResult> {
    const operation = outgoingSchema.parse(input);
    if (this.pending && JSON.stringify(this.pending) !== JSON.stringify(operation)) {
      return Promise.reject(new Error('יש להשלים את שליחת ההודעה הקודמת לפני הודעה נוספת.'));
    }
    if (this.inFlight) return this.inFlight;
    this.pending = operation;
    const attempt = Promise.resolve().then(async (): Promise<DeliveryResult> => {
      if (operation.conversationId) {
        const { message } = await this.transport.send(operation);
        return { conversationId: operation.conversationId, message };
      }
      return this.transport.create(operation);
    }).then(result => { this.pending = null; return result; });
    this.inFlight = attempt.finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  return [...new Map([...current, ...incoming].map(message => [message.id, message])).values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
export function mergeConversations(current: ChatConversation[], incoming: ChatConversation[]) {
  return [...new Map([...current, ...incoming].map(conversation => [conversation.id, conversation])).values()]
    .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at) || b.id.localeCompare(a.id));
}
export function parseOutgoing(value: string | null): OutgoingMessage | null {
  try { return value ? outgoingSchema.parse(JSON.parse(value)) : null; } catch { return null; }
}
export function confirmedOutgoing(operation: OutgoingMessage, messages: ChatMessage[], userId: string) {
  return messages.find(message => message.conversation_id === operation.conversationId
    && message.client_message_id === operation.requestId && message.sender_type === 'employee'
    && message.sender_user_id === userId && message.body === operation.body);
}
export function conversationIdFrom(value: string | null): string | null {
  const parsed = uuid.safeParse(value); return parsed.success ? parsed.data : null;
}
