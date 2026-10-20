import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messagePageQuerySchema } from '../src/lib/persistence-validation';

const mocks = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), adminRpc: vi.fn(), profile: vi.fn()
}));
vi.mock('server-only', () => ({}));
vi.mock('../src/lib/supabase-server', () => ({
  createSupabaseServerClient: async () => ({ from: mocks.from, rpc: mocks.rpc })
}));
vi.mock('../src/lib/supabase-admin', () => ({
  supabaseAdmin: { rpc: mocks.adminRpc }
}));
vi.mock('../src/lib/require-authenticated-user', () => ({
  getAuthenticatedProfile: mocks.profile
}));

import {
  createConversationWithFirstMessage, listConversationMessages,
  sendConversationMessage, appendAssistantMessage, listConversations
} from '../src/lib/conversation-repository';
import { createRepresentativeRequest } from '../src/lib/representative-request-repository';

const id = '9a9dd2bf-2c8f-41d5-b160-842aa36baa19';
const timestamp = '2026-10-18T12:00:00.123456+00:00';

function builder(result: { data: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'or', 'insert']) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn(async () => result);
  query.maybeSingle = vi.fn(async () => result);
  query.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve));
  return query;
}

beforeEach(() => vi.resetAllMocks());

describe('advisor persistence repositories', () => {
  it('preserves a first-message idempotency conflict without exposing other database errors', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'Idempotency key reused with different request' } });
    await expect(createConversationWithFirstMessage('hello', id)).rejects.toThrow('Idempotency key reused');
    expect(mocks.rpc).toHaveBeenCalledWith('advisor_create_conversation_with_first_message', {
      p_body: 'hello', p_client_request_id: id
    });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'private diagnostic' } });
    await expect(createConversationWithFirstMessage('hello')).rejects.toThrow('Failed to create conversation');
  });

  it('uses the database default status with only granted representative-request columns', async () => {
    const query = builder({ data: { id }, error: null });
    mocks.from.mockReturnValue(query);
    await createRepresentativeRequest(id, 'employee', 'question');
    expect(mocks.from).toHaveBeenCalledWith('advisor_representative_requests');
    expect(query.insert).toHaveBeenCalledWith({ conversation_id: id, owner_user_id: 'employee', topic: 'question' });
  });

  it('bounds representative assignment lookup before maybeSingle and derives sender identity', async () => {
    const assignment = builder({ data: { assigned_representative_id: 'rep' }, error: null });
    const messages = builder({ data: { id }, error: null });
    mocks.from.mockReturnValueOnce(assignment).mockReturnValueOnce(messages);
    await sendConversationMessage(id, 'rep', 'representative', 'reply');
    expect(assignment.limit).toHaveBeenCalledWith(1);
    expect(assignment.order).toHaveBeenCalledWith('requested_at', { ascending: false });
    expect(messages.insert).toHaveBeenCalledWith(expect.objectContaining({ sender_type: 'representative', sender_user_id: 'rep' }));
  });

  it('denies an unassigned representative before writing', async () => {
    mocks.from.mockReturnValue(builder({ data: null, error: null }));
    await expect(sendConversationMessage(id, 'rep', 'representative', 'reply')).rejects.toThrow('not assigned');
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it('uses timestamp and ID together so same-timestamp rows are not skipped', async () => {
    const query = builder({ data: [{ id: 'newer' }, { id: 'older' }], error: null });
    mocks.from.mockReturnValue(query);
    const messages = await listConversationMessages(id, { createdAt: timestamp, id }, 2);
    expect(query.or).toHaveBeenCalledWith(`created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${id})`);
    expect(query.order.mock.calls).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
    expect(messages.map(message => message.id)).toEqual(['older', 'newer']);
  });

  it('rejects filter injection at the repository boundary', async () => {
    const query = builder({ data: [], error: null });
    mocks.from.mockReturnValue(query);
    await expect(listConversationMessages(id, { createdAt: timestamp + ',id.gt.0', id }, 2)).rejects.toThrow();
    expect(query.or).not.toHaveBeenCalled();
  });

  it('requires both cursor parts and preserves microsecond precision', () => {
    expect(messagePageQuerySchema.safeParse({ before: timestamp }).success).toBe(false);
    expect(messagePageQuerySchema.safeParse({ beforeId: id }).success).toBe(false);
    expect(messagePageQuerySchema.parse({ before: timestamp, beforeId: id }).before).toBe(timestamp);
    expect(messagePageQuerySchema.safeParse({ before: timestamp, beforeId: 'bad' }).success).toBe(false);
  });

  it('never invokes the service-role assistant RPC for an unauthenticated caller', async () => {
    mocks.profile.mockResolvedValue(null);
    await expect(appendAssistantMessage(id, 'employee', 'answer')).rejects.toThrow('authentication');
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('lists owned history without status or session filters', async () => {
    const query = builder({ data: [{ id, status: 'open' }], error: null });
    mocks.from.mockReturnValue(query);
    expect(await listConversations('employee')).toEqual([{ id, status: 'open' }]);
    expect(query.eq.mock.calls).toEqual([['owner_user_id', 'employee']]);
    expect(query.insert).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('continues an existing employee conversation without creating a replacement', async () => {
    const conversation = builder({ data: { id, owner_user_id: 'employee', status: 'open' }, error: null });
    const messages = builder({ data: { id: 'message', conversation_id: id }, error: null });
    mocks.from.mockReturnValueOnce(conversation).mockReturnValueOnce(messages);
    await sendConversationMessage(id, 'employee', 'employee', 'continue here');
    expect(messages.insert).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: id, sender_type: 'employee', sender_user_id: 'employee'
    }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('pages older conversations with timestamp and ID while keeping owner scope', async () => {
    const query = builder({ data: [], error: null });
    mocks.from.mockReturnValue(query);
    await listConversations('employee', { createdAt: timestamp, id }, 100);
    expect(query.eq.mock.calls).toEqual([['owner_user_id', 'employee']]);
    expect(query.or).toHaveBeenCalledWith(`last_message_at.lt.${timestamp},and(last_message_at.eq.${timestamp},id.lt.${id})`);
  });
});
