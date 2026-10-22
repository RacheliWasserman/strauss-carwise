import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profile: vi.fn(), conversation: vi.fn(), send: vi.fn(), create: vi.fn(), append: vi.fn(), generateContent: vi.fn()
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/lib/conversation-repository', () => ({ getConversation: mocks.conversation, sendConversationMessage: mocks.send,
  createConversationWithFirstMessage: mocks.create, appendAssistantMessage: mocks.append }));
vi.mock('@google/genai', () => ({ GoogleGenAI: vi.fn(() => ({ models: { generateContent: mocks.generateContent } })) }));

import { POST } from '../src/app/api/conversations/[conversationId]/payslip/route';
import { VISION_CONSENT_VERSION } from '../src/lib/payslip/payslip-contract';

process.env.SUPABASE_SECRET_KEY ||= 'test-only-secret';
const conversationId: string = randomUUID();
const params = (id = conversationId) => ({ params: Promise.resolve({ conversationId: id }) });
const fixture = (name: string) => readFileSync(`tests/fixtures/payslips/${name}`);
function upload(name: string | null, options: { consent?: string; extraFile?: boolean; origin?: string; id?: string; bytes?: Uint8Array } = {}) {
  const form = new FormData();
  if (name) form.append('file', new Blob([(options.bytes ?? fixture(name)) as unknown as BlobPart]), name);
  if (options.extraFile) form.append('file', new Blob([fixture('payslip-a.pdf') as unknown as BlobPart]), 'second.pdf');
  if (options.consent) form.append('consent', options.consent);
  const headers: Record<string, string> = {};
  if (options.origin) headers.origin = options.origin;
  return POST(new Request(`http://localhost/api/conversations/${options.id ?? conversationId}/payslip`, { method: 'POST', body: form, headers }), params(options.id));
}
const visionA = { is_payslip: true, legibility: 'good', candidates: [
  { field: 'base_salary', label_text: 'שכר יסוד', value_text: '18,500.00', unit: 'currency' },
  { field: 'employee_pension_percent', label_text: 'פנסיה % עובד', value_text: '6.00%', unit: 'percent', column: 'employee' }] };

let userId: string;
beforeEach(() => {
  vi.resetAllMocks();
  userId = randomUUID(); // A fresh employee per test (independent upload limits).
  mocks.profile.mockResolvedValue({ userId, role: 'employee' });
  mocks.conversation.mockImplementation(async (id: string) => ({ id, owner_user_id: userId }));
  mocks.generateContent.mockResolvedValue({ text: JSON.stringify(visionA), candidates: [{ finishReason: 'STOP' }] });
  delete process.env.PAYSLIP_VISION_ENABLED;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('who may upload', () => {
  it('requires a signed-in employee who owns the conversation', async () => {
    mocks.profile.mockResolvedValueOnce(null);
    expect((await upload('payslip-a.pdf')).status).toBe(401);
    mocks.profile.mockResolvedValueOnce({ userId, role: 'representative' });
    expect((await upload('payslip-a.pdf')).status).toBe(403);
    mocks.conversation.mockResolvedValueOnce({ id: conversationId, owner_user_id: randomUUID() });
    expect((await upload('payslip-a.pdf')).status).toBe(404);
    mocks.conversation.mockResolvedValueOnce(null);
    expect((await upload('payslip-a.pdf')).status).toBe(404);
    expect((await upload('payslip-a.pdf', { id: 'not-a-uuid' })).status).toBe(400);
    expect((await upload('payslip-a.pdf', { origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('request validation', () => {
  it('accepts exactly one file in a multipart form, and only the exact consent value', async () => {
    expect((await upload(null)).status).toBe(400);
    expect((await upload('payslip-a.pdf', { extraFile: true })).status).toBe(400);
    expect((await upload('payslip-a.pdf', { consent: 'yes' })).status).toBe(400);
    const json = await POST(new Request(`http://localhost/api/conversations/${conversationId}/payslip`, { method: 'POST', body: '{"file":"x"}',
      headers: { 'content-type': 'application/json' } }), params());
    expect(json.status).toBe(400);
  });
  it('rejects oversized bodies by header and while streaming, without buffering them', async () => {
    const declared = await POST(new Request(`http://localhost/api/conversations/${conversationId}/payslip`, { method: 'POST', body: 'x',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(10 * 1024 * 1024) } }), params());
    expect(declared.status).toBe(413);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream({ pull(controller) { if (sent++ < 8) controller.enqueue(chunk); else controller.close(); } });
    const streamed = await POST(new Request(`http://localhost/api/conversations/${conversationId}/payslip`, { method: 'POST', body: stream,
      headers: { 'content-type': 'multipart/form-data; boundary=x' }, duplex: 'half' } as RequestInit), params());
    expect(streamed.status).toBe(413);
    expect(sent).toBeLessThan(8); // Reading stopped at the limit.
  });
  it('explains unsupported, legacy and corrupt files', async () => {
    const legacy = await upload('old.doc', { bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]) });
    expect(legacy.status).toBe(415);expect((await legacy.json()).error).toContain('DOCX');
    expect((await upload('fake.pdf', { bytes: new TextEncoder().encode('not a pdf at all') })).status).toBe(415);
    expect((await upload('broken.pdf', { bytes: new TextEncoder().encode('%PDF-1.7 broken') })).status).toBe(422);
  });
  it('limits repeated uploads per employee', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) statuses.push((await upload('payslip-a.docx')).status);
    expect(statuses.slice(0, 10).every(status => status === 200)).toBe(true);expect(statuses[10]).toBe(429);
  });
});

describe('extraction through the route', () => {
  it('reads a digital PDF locally; stores nothing and logs no document content or values', async () => {
    const response = await upload('payslip-a.pdf');
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ status: 'extracted', method: 'pdf_text' });
    expect(body.fields.find((item: { field: string }) => item.field === 'base_salary').value).toBe(18500);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();expect(mocks.append).not.toHaveBeenCalled();
    const logged = JSON.stringify([(console.info as ReturnType<typeof vi.fn>).mock.calls, (console.warn as ReturnType<typeof vi.fn>).mock.calls]);
    for (const secret of ['18500', '18,500', '000000018', 'payslip-a', 'שכר', 'דנה', userId]) expect(logged).not.toContain(secret);
  });
  it('an image asks for consent first; nothing is sent to Gemini without it, even when enabled', async () => {
    process.env.PAYSLIP_VISION_ENABLED = 'true';process.env.GEMINI_API_KEY ||= 'test-key-not-real';
    const body = await (await upload('payslip-a-screenshot.png')).json();
    expect(body).toEqual({ status: 'needs_vision', reason: 'image', visionAvailable: true });
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });
  it('consent while visual reading is not enabled: a clear message and manual entry, no provider call', async () => {
    const response = await upload('payslip-a-screenshot.png', { consent: VISION_CONSENT_VERSION });
    expect(response.status).toBe(503);expect((await response.json()).code).toBe('vision_disabled');
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });
  it('with consent and enabled: exactly one Gemini request, validated values, no other provider', async () => {
    process.env.PAYSLIP_VISION_ENABLED = 'true';process.env.GEMINI_API_KEY ||= 'test-key-not-real';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await upload('payslip-a-photo.jpg', { consent: VISION_CONSENT_VERSION });
    const body = await response.json();
    expect(response.status).toBe(200);expect(body).toMatchObject({ status: 'extracted', method: 'vision' });
    expect(body.fields.filter((item: { value: number | null }) => item.value !== null).map((item: { field: string; value: number }) => [item.field, item.value]))
      .toEqual([['base_salary', 18500], ['employee_pension_percent', 6]]);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);expect(fetchSpy).not.toHaveBeenCalled();
    const logged = JSON.stringify((console.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('18500');
  });
  it('LIVE REGRESSION: Google 503 "high demand" is retried on the same model only, then reported as a temporary overload with a reference', async () => {
    process.env.PAYSLIP_VISION_ENABLED = 'true';process.env.GEMINI_API_KEY ||= 'test-key-not-real';
    mocks.generateContent.mockRejectedValue(Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'), { status: 503 }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await upload('payslip-a-screenshot.png', { consent: VISION_CONSENT_VERSION });
    const body = await response.json();
    expect(response.status).toBe(503);expect(body.code).toBe('vision_busy');expect(body.error).toContain('עמוס');
    expect(body.ref).toMatch(/^[a-f0-9]{8}$/);
    expect(mocks.generateContent).toHaveBeenCalledTimes(3);expect(fetchSpy).not.toHaveBeenCalled(); // No other provider.
    const warned = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(warned).toContain(body.ref);expect(warned).toContain('"httpStatus":503');expect(warned).toContain('"googleStatus":"UNAVAILABLE"');
    expect(warned).toContain('"attempts":3');expect(warned).toContain('"stage":"request"');
    expect(warned).not.toContain('high demand');expect(warned).not.toContain('test-key-not-real');
  }, 20_000);
  it('a 503 followed by success extracts normally; a consent of the old wording (v1) is refused', async () => {
    process.env.PAYSLIP_VISION_ENABLED = 'true';process.env.GEMINI_API_KEY ||= 'test-key-not-real';
    mocks.generateContent.mockRejectedValueOnce(Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'), { status: 503 }));
    const response = await upload('payslip-a-screenshot.png', { consent: VISION_CONSENT_VERSION });
    expect(response.status).toBe(200);expect((await response.json()).status).toBe('extracted');
    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    expect((await upload('payslip-a-screenshot.png', { consent: 'carwise.payslip-vision-consent.v1' })).status).toBe(400);
  }, 20_000);
});
