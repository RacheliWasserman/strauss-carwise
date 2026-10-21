import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profile: vi.fn(), role: vi.fn(), create: vi.fn(), list: vi.fn(),
  conversation: vi.fn(), messages: vi.fn(), send: vi.fn(), request: vi.fn()
}));
vi.mock('../src/lib/representative-request-repository', () => ({ getRequestForRepresentative: mocks.request }));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/lib/persistence-api-auth', () => ({ requireApiRole: mocks.role }));
vi.mock('@/lib/conversation-repository', () => ({
  createConversationWithFirstMessage: mocks.create,
  listConversations: mocks.list,
  getConversation: mocks.conversation,
  listConversationMessages: mocks.messages,
  sendConversationMessage: mocks.send
}));
vi.mock('@/lib/persistence-validation', async () => import('../src/lib/persistence-validation'));

import { POST, GET as getConversationList } from '../src/app/api/conversations/route';
import { GET, POST as postMessage } from '../src/app/api/conversations/[conversationId]/messages/route';
import { GET as getConversationDetails } from '../src/app/api/conversations/[conversationId]/route';

const id = '9a9dd2bf-2c8f-41d5-b160-842aa36baa19';
const timestamp = '2026-10-18T12:00:00.123456+00:00';
const params = () => ({ params: Promise.resolve({ conversationId: id }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.profile.mockResolvedValue({ userId: 'employee', role: 'employee' });
  mocks.role.mockResolvedValue({ profile: { userId: 'employee', role: 'employee' } });
  mocks.conversation.mockResolvedValue({ id, owner_user_id: 'employee' });
});

it('returns HTTP 409 for first-message idempotency conflicts', async () => {
  mocks.create.mockRejectedValue(new Error('Idempotency key reused with different request'));
  const response = await POST(new Request('http://localhost/api/conversations', {
    method: 'POST', body: JSON.stringify({ body: 'hello', clientRequestId: id })
  }));
  expect(response.status).toBe(409);
});

it('returns a composite cursor and forwards both parts unchanged', async () => {
  mocks.messages.mockResolvedValue([{ id, created_at: timestamp }]);
  const url = new URL(`http://localhost/api/conversations/${id}/messages`);
  url.searchParams.set('before', timestamp);
  url.searchParams.set('beforeId', id);
  url.searchParams.set('limit', '1');
  const response = await GET(new Request(url), params());
  expect(response.status).toBe(200);
  expect(mocks.messages).toHaveBeenCalledWith(id, { createdAt: timestamp, id }, 1);
  expect(await response.json()).toEqual({
    messages: [{ id, created_at: timestamp }], nextCursor: { before: timestamp, beforeId: id }
  });
});

it('rejects timestamp-only pagination instead of silently skipping tied rows', async () => {
  const response = await GET(new Request(`http://localhost/api/conversations/${id}/messages?before=2026-10-18T12:00:00Z`), params());
  expect(response.status).toBe(400);
  expect(mocks.messages).not.toHaveBeenCalled();
});

it('denies cross-employee message reads before querying messages', async () => {
  mocks.conversation.mockResolvedValue({ id, owner_user_id: 'other-employee' });
  const response = await GET(new Request(`http://localhost/api/conversations/${id}/messages`), params());
  expect(response.status).toBe(404);
  expect(mocks.messages).not.toHaveBeenCalled();
});

it('denies unauthenticated message reads', async () => {
  mocks.profile.mockResolvedValue(null);
  const response = await GET(new Request(`http://localhost/api/conversations/${id}/messages`), params());
  expect(response.status).toBe(401);
  expect(mocks.messages).not.toHaveBeenCalled();
});

it('never lets a representative read conversation details or messages, even when assigned (least privilege)', async () => {
  mocks.profile.mockResolvedValue({ userId: 'assigned-rep', role: 'representative' });
  expect((await getConversationDetails(new Request(`http://localhost/api/conversations/${id}`), params())).status).toBe(403);
  expect((await GET(new Request(`http://localhost/api/conversations/${id}/messages`), params())).status).toBe(403);
  expect(mocks.conversation).not.toHaveBeenCalled();expect(mocks.messages).not.toHaveBeenCalled();
});

it('reads the same saved conversation after repeated refresh and a new authenticated session', async () => {
  mocks.messages.mockResolvedValue([{ id, created_at: timestamp, body: 'saved' }]);
  const request = () => new Request(`http://localhost/api/conversations/${id}/messages`);
  for (let refresh = 0; refresh < 2; refresh++) {
    expect((await GET(request(), params())).status).toBe(200);
  }
  mocks.profile.mockResolvedValue(null);
  expect((await GET(request(), params())).status).toBe(401);
  mocks.profile.mockResolvedValue({ userId: 'employee', role: 'employee' });
  expect((await (await GET(request(), params())).json()).messages).toEqual([
    { id, created_at: timestamp, body: 'saved' }
  ]);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it('creates a new conversation without changing the existing one', async () => {
  mocks.create.mockResolvedValue(id);
  const response = await POST(new Request('http://localhost/api/conversations', {
    method: 'POST', body: JSON.stringify({ body: 'new conversation' })
  }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ conversationId: id });
  expect(mocks.send).not.toHaveBeenCalled();
});

it('allows paging to older saved conversations beyond the first list page', async () => {
  mocks.list.mockResolvedValue([{ id, last_message_at: timestamp }]);
  const url = new URL('http://localhost/api/conversations');
  url.searchParams.set('before', timestamp);
  url.searchParams.set('beforeId', id);
  url.searchParams.set('limit', '1');
  const response = await getConversationList(new Request(url));
  expect(response.status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith('employee', { createdAt: timestamp, id }, 1);
  expect((await response.json()).nextCursor).toEqual({ before: timestamp, beforeId: id });
});

describe('representative structured answers through the real messages route', () => {
  const requestId = 'b1f6a4b8-6a7e-4b52-9b0f-0c5d2a1e9f11';
  const answer = (value: number, field = 'current_participation') => JSON.stringify({ kind: 'carwise.rep-answer.v1', requestId, field, value, answeredAt: '2026-10-21T10:00:00.000Z' });
  const post = (body: string) => postMessage(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ body }) }), params());
  const request = (status: string, assigned = 'rep') => ({ id: requestId, conversation_id: id, status, topic: 'שדה חסר: השתתפות חודשית ברכב היום [current_participation]', assigned_representative_id: assigned });
  beforeEach(() => { mocks.profile.mockResolvedValue({ userId: 'rep', role: 'representative' }); mocks.send.mockResolvedValue({ id: 'm' }); });
  it('stores the first valid answer of the assigned representative', async () => {
    mocks.request.mockResolvedValue(request('claimed'));
    expect((await post(answer(300))).status).toBe(201);expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('rejects a second answer to an already answered request (409) without storing it', async () => {
    mocks.request.mockResolvedValue(request('answered'));
    const response = await post(answer(320));
    expect(response.status).toBe(409);expect((await response.json()).error).toContain('כבר נשלחה');expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([
    ['another representative', () => request('claimed', 'other-rep'), answer(300)],
    ['a different field', () => request('claimed'), answer(300, 'bonus')],
    ['an out-of-range value', () => request('claimed'), answer(-5)],
    ['a malformed answer', () => request('claimed'), '{"kind":"carwise.rep-answer.v1","value":"x"}']
  ])('rejects %s without storing it', async (_label, row, body) => {
    mocks.request.mockResolvedValue(row());
    expect((await post(body)).status).toBe(400);expect(mocks.send).not.toHaveBeenCalled();
  });
});
