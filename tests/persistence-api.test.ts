import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profile: vi.fn(), role: vi.fn(), create: vi.fn(), list: vi.fn(),
  conversation: vi.fn(), messages: vi.fn(), send: vi.fn()
}));
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
import { GET } from '../src/app/api/conversations/[conversationId]/messages/route';
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

it('allows an assigned representative to load conversation details through user-scoped access', async () => {
  mocks.profile.mockResolvedValue({ userId: 'assigned-rep', role: 'representative' });
  const response = await getConversationDetails(new Request(`http://localhost/api/conversations/${id}`), params());
  expect(response.status).toBe(200);
  expect(mocks.conversation).toHaveBeenCalledWith(id, 'assigned-rep', 'representative');
});

it('returns 404 when RLS hides conversation details from another representative', async () => {
  mocks.profile.mockResolvedValue({ userId: 'other-rep', role: 'representative' });
  mocks.conversation.mockResolvedValue(null);
  const response = await getConversationDetails(new Request(`http://localhost/api/conversations/${id}`), params());
  expect(response.status).toBe(404);
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
