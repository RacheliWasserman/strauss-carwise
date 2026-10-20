import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ profile: vi.fn(), run: vi.fn() }));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/lib/ai/assistant-service', () => ({ runAssistantTurn: mocks.run, AssistantError: class extends Error {} }));
import { POST } from '../src/app/api/conversations/[conversationId]/assistant/route';
const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ conversationId }) };
const request = (body: unknown) => new Request(`http://localhost/api/conversations/${conversationId}/assistant`, { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.profile.mockResolvedValue({ userId: 'server-user', role: 'employee' }); });

it('denies unauthenticated AI requests before any provider/storage work', async () => {
  mocks.profile.mockResolvedValue(null);
  expect((await POST(request({ messageId }), params)).status).toBe(401);
  expect(mocks.run).not.toHaveBeenCalled();
});
it('rejects a cross-origin browser request before authentication or model access', async () => {
  const response = await POST(new Request(`http://localhost/api/conversations/${conversationId}/assistant`, {
    method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: JSON.stringify({ messageId })
  }), params);
  expect(response.status).toBe(403); expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});
it('denies representative accounts before generation', async () => {
  mocks.profile.mockResolvedValue({ userId: 'rep', role: 'representative' });
  expect((await POST(request({ messageId }), params)).status).toBe(403);
  expect(mocks.run).not.toHaveBeenCalled();
});
it('rejects caller-supplied user identity and raw prompt data', async () => {
  expect((await POST(request({ messageId, ownerUserId: 'forged', body: 'prompt' }), params)).status).toBe(400);
  expect(mocks.run).not.toHaveBeenCalled();
});
it('uses only authenticated identity and a saved message reference', async () => {
  mocks.run.mockResolvedValue({ status: 'complete', message: { id: 'saved-reply' } });
  const response = await POST(request({ messageId }), params);
  expect(response.status).toBe(200);
  expect(mocks.run).toHaveBeenCalledWith({ userId: 'server-user', role: 'employee' }, conversationId, messageId, { statusOnly: undefined });
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('returns pending without pretending a reply was saved', async () => {
  mocks.run.mockResolvedValue({ status: 'pending' });
  const response = await POST(request({ messageId, statusOnly: true }), params);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'pending' });
});
it('does not expose provider errors or credentials in failure responses', async () => {
  mocks.run.mockRejectedValue(new Error('sensitive-provider-diagnostic'));
  const response = await POST(request({ messageId }), params);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('sensitive-provider');
});
