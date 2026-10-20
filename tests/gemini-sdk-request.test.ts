import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
// Use the installed SDK, mocking only its HTTP transport: no real AI requests.
import { generateReply } from '../src/lib/ai/providers';
import { CARWISE_SYSTEM } from '../src/lib/ai/config';
import { GoogleGenAI } from '@google/genai';
import { geminiDiagnostic } from '../src/lib/ai/gemini-diagnostics';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('serializes the Gemini text request with the installed Google SDK', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('GEMINI_API_KEY', 'offline-test-key');
  vi.stubEnv('GEMINI_MODEL', 'gemini-3.5-flash-lite');
  vi.stubEnv('GROQ_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '');
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [
    { content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }
  ] }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', transport);
  expect(await generateReply([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next' }])).toBe('Hello');
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, options] = transport.mock.calls[0];
  expect(String(url)).toContain('/v1beta/models/gemini-3.5-flash-lite:generateContent');
  const body = JSON.parse(options.body);
  expect(body.contents.map((message: { role: string }) => message.role)).toEqual(['user', 'model', 'user']);
  expect(body.systemInstruction.parts).toEqual([{ text: CARWISE_SYSTEM }]);
  expect(body.generationConfig.maxOutputTokens).toBe(700);
  expect(body.generationConfig).not.toHaveProperty('temperature');
  expect(options.body).not.toContain('offline-test-key');
  expect(log).toHaveBeenCalledWith('[carwise.ai.gemini.request]', expect.objectContaining({
    modelMatchesProbe: true, backend: 'gemini_api', keyPresent: true,
    keyFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/), messageCount: 3,
    roles: ['user', 'model', 'user'], maxOutputTokens: 700
  }));
  expect(new Headers(options.headers).get('x-server-timeout')).toBe('20');
  expect(JSON.stringify(log.mock.calls)).not.toContain('offline-test-key');
  log.mockRestore();
});

const stages = [
  { name: 'minimal user message', contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], config: {} },
  { name: 'system instruction', contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], config: { systemInstruction: CARWISE_SYSTEM } },
  { name: 'output limit', contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], config: { systemInstruction: CARWISE_SYSTEM, maxOutputTokens: 700 } },
  { name: 'history', contents: [{ role: 'user', parts: [{ text: 'Hello' }] }, { role: 'model', parts: [{ text: 'Hi' }] }, { role: 'user', parts: [{ text: 'Next' }] }], config: { systemInstruction: CARWISE_SYSTEM, maxOutputTokens: 700 } },
  { name: 'consecutive user turns', contents: [{ role: 'user', parts: [{ text: 'Hello' }] }, { role: 'user', parts: [{ text: 'Service note' }] }], config: { systemInstruction: CARWISE_SYSTEM, maxOutputTokens: 700 } }
];
it.each(stages)('isolates SDK serialization: $name', async ({ contents, config }) => {
  const signal = new AbortController().signal;
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', transport);
  const client = new GoogleGenAI({ apiKey: 'offline-key', httpOptions: { timeout: 7000, retryOptions: { attempts: 1 } } });
  await client.models.generateContent({ model: 'gemini-3.5-flash-lite', contents, config: { ...config, abortSignal: signal } });
  const [url, options] = transport.mock.calls[0];
  expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  expect(options.method).toBe('POST');
  const body = JSON.parse(options.body);
  const expected: Record<string, unknown> = { contents, generationConfig: {} };
  if (config.systemInstruction) expected.systemInstruction = { role: 'user', parts: [{ text: CARWISE_SYSTEM }] };
  if (config.maxOutputTokens) expected.generationConfig = { maxOutputTokens: 700 };
  expect(body).toEqual(expected);
  expect(transport).toHaveBeenCalledTimes(1);
});

it('decodes a genuine SDK ApiError and exposes only fixed invalid-field groups', async () => {
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
    code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument. private conversation',
    details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [
      { field: 'generation_config.max_output_tokens', description: 'private salary' },
      { field: 'secret-private-user-field', description: 'offline-key' }
    ] }]
  } }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', transport);
  const client = new GoogleGenAI({ apiKey: 'offline-key', httpOptions: { retryOptions: { attempts: 1 } } });
  let failure: unknown;
  try { await client.models.generateContent({ model: 'gemini-3.5-flash-lite', contents: 'Hello' }); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ name: 'ApiError', status: 400 });
  const diagnostic = geminiDiagnostic(failure);
  expect(diagnostic).toMatchObject({ googleStatus: 'INVALID_ARGUMENT', detail: 'invalid_field', fields: ['generationConfig', 'other'], envelopeShape: 'google_error' });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private|salary|offline-key/);
  expect(transport).toHaveBeenCalledTimes(1);
});
it('classifies a short-deadline HTTP 400 from the real SDK without fallback or retry', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'offline-key');
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
    code: 400, status: 'INVALID_ARGUMENT', message: 'Manually set deadline 7s is too short. Minimum allowed deadline is 10s.'
  } }), { status: 400, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', transport);
  await expect(generateReply([{ role: 'user', content: 'Hello' }])).rejects.toMatchObject({ status: 400, retryable: false, diagnostic: { detail: 'deadline_too_short' } });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(new Headers(transport.mock.calls[0][1].headers).get('x-server-timeout')).toBe('20');
});
