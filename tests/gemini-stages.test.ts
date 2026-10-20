import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import { EventEmitter } from 'node:events';
vi.mock('server-only', () => ({}));
import { AI_LIMITS, CARWISE_SYSTEM } from '../src/lib/ai/config';
import { geminiDiagnostic } from '../src/lib/ai/gemini-diagnostics';
const localRequire = createRequire(import.meta.url);
const { names, stageRequest, runStage, parseArgs, sendOnce } = localRequire('../scripts/diagnose-gemini-stages.cjs');
const settings = { AI_LIMITS, CARWISE_SYSTEM };
const ok = () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });

it.each(names as string[])('builds stage %s with no network when live mode is absent', async name => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must not be used'));
  try {
    const result = await runStage(name, settings, geminiDiagnostic, { GoogleGenAI });
    expect(result).toMatchObject({ liveRequests: 0, diagnostic: 'offline_serialization_only' });
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
it('changes output limit and system instruction in separate stages', () => {
  const minimal = stageRequest('sdk-minimal', settings);
  const limit = stageRequest('output-limit', settings);
  expect(minimal.config).toEqual({ maxOutputTokens: 32 });
  expect(limit).toEqual({ ...minimal, config: { maxOutputTokens: 700 } });
  expect(stageRequest('sdk-simple-system', settings).config.systemInstruction).toBe('You are a helpful assistant. Reply briefly.');
  expect(stageRequest('sdk-carwise-system', settings).config.systemInstruction).toBe(CARWISE_SYSTEM);
});
it('proves the chat-timeout stage changes the server timeout header but not JSON', async () => {
  const normal = vi.fn(async () => ok());
  const chat = vi.fn(async () => ok());
  await runStage('sdk-carwise-system', settings, geminiDiagnostic, { send: normal, GoogleGenAI });
  await runStage('sdk-chat-timeout', settings, geminiDiagnostic, { send: chat, GoogleGenAI });
  const request = (mock: typeof normal) => (mock.mock.calls[0] as unknown as [string, { body: string; headers: HeadersInit }]);
  expect(request(normal)[0]).toBe(request(chat)[0]);
  expect(JSON.parse(request(normal)[1].body)).toEqual(JSON.parse(request(chat)[1].body));
  expect(new Headers(request(normal)[1].headers).get('x-server-timeout')).toBe('10');
  expect(new Headers(request(chat)[1].headers).get('x-server-timeout')).toBe('7');
  expect(normal).toHaveBeenCalledTimes(1); expect(chat).toHaveBeenCalledTimes(1);
});
it('compares REST without system role against SDK wire payload with identical other fields', async () => {
  const rest = vi.fn(async () => ok());
  const sdk = vi.fn(async () => ok());
  await runStage('rest-system-no-role', settings, geminiDiagnostic, { key: 'offline-key', send: rest, GoogleGenAI });
  await runStage('sdk-carwise-system', settings, geminiDiagnostic, { key: 'offline-key', send: sdk, GoogleGenAI });
  const restBody = JSON.parse((rest.mock.calls[0] as unknown as [string, { body: string }])[1].body);
  const sdkBody = JSON.parse((sdk.mock.calls[0] as unknown as [string, { body: string }])[1].body);
  expect(sdkBody).toEqual({ ...restBody, systemInstruction: { ...restBody.systemInstruction, role: 'user' } });
  expect(rest).toHaveBeenCalledTimes(1); expect(sdk).toHaveBeenCalledTimes(1);
});
it.each([400, 429, 503])('makes one mocked transport call even on HTTP %s', async status => {
  const send = vi.fn(async () => new Response(JSON.stringify({ error: { code: status, status: 'INVALID_ARGUMENT', message: 'Private prompt offline-key' } }), { status, headers: { 'content-type': 'application/json' } }));
  const result = await runStage('sdk-minimal', settings, geminiDiagnostic, { key: 'offline-key', send, GoogleGenAI });
  expect(send).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ httpStatus: status, liveRequests: 1, diagnostic: 'provider_rejected' });
  expect(JSON.stringify(result)).not.toMatch(/Private prompt|offline-key/);
});
it('does not retry a transport error or reveal its message', async () => {
  const send = vi.fn(async () => { throw new TypeError('fetch failed: offline-key private data'); });
  const result = await runStage('sdk-minimal', settings, geminiDiagnostic, { key: 'offline-key', send, GoogleGenAI });
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.diagnostic).toBe('network_error');
  expect(JSON.stringify(result)).not.toMatch(/offline-key|private data/);
});
it('recognizes output-limit and retains sdk-limit as a compatible alias', () => {
  expect(parseArgs(['--stage', 'output-limit', '--live-one'])).toEqual({ name: 'output-limit', live: true });
  expect(parseArgs(['--stage', 'sdk-limit'])).toEqual({ name: 'output-limit', live: false });
  expect(stageRequest('sdk-limit', settings)).toEqual(stageRequest('output-limit', settings));
  expect(() => parseArgs(['--stage', 'unknown', '--live-one'])).toThrow(expect.objectContaining({ phase: 'arguments', detail: 'invalid_stage_or_arguments' }));
});
it('changes exactly one field of the actual SDK HTTP payload for output-limit', async () => {
  const baseline = vi.fn(async () => ok());
  const limit = vi.fn(async () => ok());
  await runStage('sdk-minimal', settings, geminiDiagnostic, { send: baseline, GoogleGenAI });
  await runStage('output-limit', settings, geminiDiagnostic, { send: limit, GoogleGenAI });
  const body = (mock: typeof baseline) => JSON.parse((mock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
  expect(body(baseline).generationConfig).toEqual({ maxOutputTokens: 32 });
  expect(body(limit)).toEqual({ ...body(baseline), generationConfig: { maxOutputTokens: 700 } });
  expect(limit).toHaveBeenCalledTimes(1);
});
it('labels local SDK setup errors before any network attempt', async () => {
  class BrokenSDK { constructor() { throw new Error('private secret'); } }
  const send = vi.fn();
  const result = await runStage('output-limit', settings, geminiDiagnostic, { send, GoogleGenAI: BrokenSDK });
  expect(result).toMatchObject({ phase: 'build_request', diagnostic: 'local_script_error', liveRequests: 0, httpStatus: null });
  expect(send).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('private secret');
});
it('labels failures after an HTTP 200 as response processing errors', async () => {
  const send = vi.fn(async () => new Response('{not JSON', { headers: { 'content-type': 'application/json' } }));
  const result = await runStage('output-limit', settings, geminiDiagnostic, { send, GoogleGenAI });
  expect(result).toMatchObject({ phase: 'response', diagnostic: 'response_processing_failure', httpStatus: 200 });
  expect(send).toHaveBeenCalledTimes(1);
});
it('identifies a timeout without losing response status or retrying', async () => {
  const send = vi.fn(async () => { throw Object.assign(new Error('private'), { code: 'DIAGNOSTIC_TIMEOUT', httpStatus: 200 }); });
  const result = await runStage('output-limit', settings, geminiDiagnostic, { send, GoogleGenAI });
  expect(result).toMatchObject({ diagnostic: 'timeout', httpStatus: 200, liveRequests: 1 });
  expect(send).toHaveBeenCalledTimes(1);
});
it('enforces the native transport total timeout at ten seconds without another request', async () => {
  vi.useFakeTimers();
  const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  const transport = vi.spyOn(localRequire('node:https'), 'request').mockReturnValue(request);
  try {
    const pending = sendOnce('https://example.invalid', { body: '{}', headers: {} });
    const outcome = expect(pending).rejects.toMatchObject({ code: 'DIAGNOSTIC_TIMEOUT', httpStatus: null });
    await vi.advanceTimersByTimeAsync(9999);
    expect(request.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  } finally { transport.mockRestore(); vi.useRealTimers(); }
});
it('blocks an unexpected second SDK request before the transport is called again', async () => {
  const send = vi.fn(async () => ok());
  class RepeatingSDK {
    models;
    constructor(options: { httpOptions: { fetch: (url: string, options: object) => Promise<Response> } }) {
      this.models = { generateContent: async () => {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
        const request = { method: 'POST', body: JSON.stringify({ contents: [{ role: 'user' }], generationConfig: { maxOutputTokens: 32 } }) };
        await options.httpOptions.fetch(url, request);
        return options.httpOptions.fetch(url, request);
      } };
    }
  }
  const result = await runStage('sdk-minimal', settings, geminiDiagnostic, { key: 'offline-key', send, GoogleGenAI: RepeatingSDK });
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.liveRequests).toBe(1);
});
