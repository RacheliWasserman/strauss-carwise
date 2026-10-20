import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatApi, ChatDelivery, ChatApiError, confirmedOutgoing, conversationIdFrom,
  mergeConversations, mergeMessages, parseOutgoing,
  type ChatConversation, type ChatMessage, type OutgoingMessage
} from '../src/lib/chat-client';

const userId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';
const time = '2026-10-18T12:00:00.123456+00:00';
const operation: OutgoingMessage = { requestId, conversationId: null, body: 'איזה רכב הכי משתלם לי?' };
const conversation: ChatConversation = {
  id: conversationId, owner_user_id: userId, title: null, status: 'open',
  created_at: time, updated_at: time, last_message_at: time
};
const message: ChatMessage = {
  id: messageId, conversation_id: conversationId, sender_type: 'employee',
  sender_user_id: userId, body: operation.body, client_message_id: requestId, created_at: time
};
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('allows the full 34-second provider chain and bounds only assistant requests at 50 seconds', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null = null;
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    signal = options.signal!;
    signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })));
  const result = expect(chatApi.assistant(conversationId, messageId)).rejects.toMatchObject({ status: 0 });
  await vi.advanceTimersByTimeAsync(34000);
  expect(signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(15999);
  expect(signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal!.aborted).toBe(true);
  await result;
});

it('keeps the existing 30-second deadline for non-AI chat requests', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })));
  const result = expect(chatApi.list()).rejects.toMatchObject({ status: 0 });
  await vi.advanceTimersByTimeAsync(30000);
  await result;
});

describe('real Phase 2 HTTP contracts used by the employee chat', () => {
  it('creates the conversation and first message with an idempotency key, without employee/demo data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ conversationId }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new ChatDelivery().deliver(operation)).toEqual({ conversationId });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/conversations');
    expect(JSON.parse(init.body)).toEqual({ body: operation.body, clientRequestId: requestId });
    expect(init.credentials).toBe('same-origin');
  });

  it('continues the same conversation and supplies no forged sender fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ message }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new ChatDelivery().deliver({ ...operation, conversationId })).toEqual({ conversationId, message });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/conversations/${conversationId}/messages`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ body: operation.body, clientMessageId: requestId });
  });

  it('fetches saved history with both cursor fields, preserving microseconds and encoded timezone', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ conversations: [conversation], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await chatApi.list({ before: time, beforeId: conversationId });
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('before')).toBe(time);
    expect(url.searchParams.get('beforeId')).toBe(conversationId);
    expect(result.conversations).toEqual([conversation]);
    expect(fetchMock.mock.calls[0][1].cache).toBe('no-store');
  });

  it('loads old messages in the existing conversation using the API cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ messages: [message], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await chatApi.messages(conversationId, { before: time, beforeId: messageId })).messages).toEqual([message]);
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe(`/api/conversations/${conversationId}/messages`);
    expect(url.searchParams.get('beforeId')).toBe(messageId);
  });

  it('requests AI using only saved message identity and merges the saved assistant response', async () => {
    const assistant = { ...message, id: requestId, sender_type: 'assistant', sender_user_id: null, body: 'מה התפקיד שלך?' };
    const fetchMock = vi.fn().mockResolvedValue(json({ status: 'complete', message: assistant }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await chatApi.assistant(conversationId, messageId);
    expect(result.status).toBe('complete');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ messageId, statusOnly: false });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/conversations/${conversationId}/assistant`);
  });

  it('marks status polling explicitly so it cannot trigger paid provider retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ status: 'pending' })); vi.stubGlobal('fetch', fetchMock);
    expect(await chatApi.assistant(conversationId, messageId, true)).toEqual({ status: 'pending' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).statusOnly).toBe(true);
  });

  it('rejects malformed success responses rather than presenting them as saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ conversationId: 'invalid' })));
    await expect(chatApi.create(operation)).rejects.toBeInstanceOf(ChatApiError);
  });

  it('keeps authentication errors actionable and does not expose provider diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'private diagnostic' }, 401)));
    await expect(chatApi.create(operation)).rejects.toMatchObject({ status: 401 });
    expect(new ChatApiError(401).message).not.toContain('private');
  });

  it('times out a stalled write as uncertain so its idempotency key can be retried', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    try {
      const result = expect(chatApi.create(operation)).rejects.toMatchObject({ status: 0 });
      await vi.advanceTimersByTimeAsync(30000);
      await result;
    } finally { vi.useRealTimers(); }
  });

  it('preserves a cancelled history read without treating it as an unsaved write', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const result = expect(chatApi.messages(conversationId, null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await result;
  });
});

describe('duplicate prevention and network recovery', () => {
  it('coalesces simultaneous clicks before a render can disable the button', async () => {
    let finish!: (result: { conversationId: string }) => void;
    const create = vi.fn(() => new Promise<{ conversationId: string }>(resolve => { finish = resolve; }));
    const delivery = new ChatDelivery({ ...chatApi, create });
    const first = delivery.deliver(operation);
    const second = delivery.deliver(operation);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    finish({ conversationId });
    await first;
  });

  it('retries a failed first-message request with exactly the same key and payload', async () => {
    const create = vi.fn().mockRejectedValueOnce(new ChatApiError(0)).mockResolvedValueOnce({ conversationId });
    const delivery = new ChatDelivery({ ...chatApi, create });
    await expect(delivery.deliver(operation)).rejects.toThrow();
    await expect(delivery.deliver(operation)).resolves.toEqual({ conversationId });
    expect(create.mock.calls.map(call => call[0])).toEqual([operation, operation]);
  });

  it('refuses to replace an uncertain write with different text or a fresh key', async () => {
    const create = vi.fn().mockRejectedValue(new ChatApiError(0));
    const delivery = new ChatDelivery({ ...chatApi, create });
    await expect(delivery.deliver(operation)).rejects.toThrow();
    await expect(delivery.deliver({ ...operation, body: 'different' })).rejects.toThrow('הקודמת');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries continuation messages with the original clientMessageId', async () => {
    const send = vi.fn().mockRejectedValueOnce(new ChatApiError(0)).mockResolvedValue({ message });
    const delivery = new ChatDelivery({ ...chatApi, send });
    const continuation = { ...operation, conversationId };
    await expect(delivery.deliver(continuation)).rejects.toThrow();
    await delivery.deliver(continuation);
    expect(send.mock.calls.map(call => call[0].requestId)).toEqual([requestId, requestId]);
  });

  it('recovers an uncertain operation after a page reload without inventing a new key', async () => {
    const recovered = parseOutgoing(JSON.stringify(operation));
    expect(recovered).toEqual(operation);
    const create = vi.fn().mockResolvedValue({ conversationId });
    await new ChatDelivery({ ...chatApi, create }).deliver(recovered!);
    expect(create).toHaveBeenCalledWith(operation);
  });

  it('recognizes confirmed writes only when identity, text, conversation and request key all match', () => {
    const continuation = { ...operation, conversationId };
    expect(confirmedOutgoing(continuation, [message], userId)).toEqual(message);
    expect(confirmedOutgoing(continuation, [{ ...message, sender_user_id: conversationId }], userId)).toBeUndefined();
    expect(confirmedOutgoing(continuation, [{ ...message, body: 'different' }], userId)).toBeUndefined();
    expect(confirmedOutgoing(continuation, [{ ...message, client_message_id: null }], userId)).toBeUndefined();
  });
});

describe('history merging and restored navigation', () => {
  it('deduplicates overlapping message pages and keeps chronological order', () => {
    const older = { ...message, id: requestId, created_at: '2026-10-17T12:00:00+00:00' };
    expect(mergeMessages([message], [older, message]).map(item => item.id)).toEqual([requestId, messageId]);
  });

  it('keeps distinct same-timestamp messages and orders by ID', () => {
    const other = { ...message, id: requestId };
    expect(mergeMessages([message], [other]).map(item => item.id)).toEqual([requestId, messageId]);
  });

  it('deduplicates history pages and moves updated conversations to the top', () => {
    const older = { ...conversation, id: messageId, last_message_at: '2026-10-17T12:00:00+00:00' };
    const updated = { ...older, last_message_at: '2026-10-19T12:00:00+00:00' };
    expect(mergeConversations([conversation, older], [updated]).map(item => item.id)).toEqual([messageId, conversationId]);
  });

  it('ignores corrupt recovery data and validates stored/URL conversation IDs', () => {
    expect(parseOutgoing('{')).toBeNull();
    expect(parseOutgoing(JSON.stringify({ ...operation, requestId: 'bad' }))).toBeNull();
    expect(conversationIdFrom(conversationId)).toBe(conversationId);
    expect(conversationIdFrom('../../admin')).toBeNull();
    expect(conversationIdFrom('new')).toBeNull();
  });
});
