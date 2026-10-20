import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
vi.mock('server-only', () => ({}));
import { AI_LIMITS, CARWISE_SYSTEM } from '../src/lib/ai/config';
import { geminiDiagnostic } from '../src/lib/ai/gemini-diagnostics';
const requireLocal = createRequire(import.meta.url);
const { prepareRequest, compare } = requireLocal('../scripts/compare-gemini-transports.cjs');
const settings = { AI_LIMITS, CARWISE_SYSTEM };
const response = (status = 200) => new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text: 'PRIVATE_RESPONSE' }] } }] } : { error: { status: 'INVALID_ARGUMENT', message: 'PRIVATE_KEY PRIVATE_TEXT' } }), { status, headers: { 'content-type': 'application/json' } });
const prepare = () => prepareRequest('offline-fake-key', settings, geminiDiagnostic, GoogleGenAI);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('does nothing live without the separate approval flag, even without any credentials', () => {
  const script = fileURLToPath(new URL('../scripts/compare-gemini-transports.cjs', import.meta.url));
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8', env: { NODE_ENV: 'test' } });
  expect(JSON.parse(output)).toEqual({ httpStatus: null, diagnostic: 'not_run_requires_separate_approval_for_up_to_two_requests' });
});

it('sends identical payload/endpoint/headers through the real Next fetch patch and HTTPS adapter', async () => {
  const prepared = await prepare();
  let httpsUrl: unknown, httpsOptions: unknown, httpsBody: unknown;
  const request = Object.assign(new EventEmitter(), { end: vi.fn((body: unknown) => {
    httpsBody = body;
    queueMicrotask(() => {
      const incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' }, setEncoding: vi.fn() });
      respond(incoming);
      incoming.emit('data', '{}'); incoming.emit('end');
    });
  }), destroy: vi.fn() });
  let respond: (incoming: unknown) => void;
  const native = vi.spyOn(requireLocal('node:https'), 'request').mockImplementation((...args: unknown[]) => {
    httpsUrl = args[0]; httpsOptions = args[1]; respond = args[2] as typeof respond; return request;
  });
  const origin = vi.fn(async () => response());
  const result = await compare(prepared, { originFetch: origin, diagnostic: geminiDiagnostic });
  expect(result.map((item: { diagnostic: string }) => item.diagnostic)).toEqual(['accepted', 'accepted']);
  expect(origin).toHaveBeenCalledTimes(1); expect(native).toHaveBeenCalledTimes(1);
  const [url, options] = origin.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(httpsUrl);
  expect(options.body).toBe(httpsBody);
  const normalize = (headers: HeadersInit) => [...new Headers(headers).entries()].sort();
  expect(normalize(options.headers!)).toEqual(normalize((httpsOptions as { headers: HeadersInit }).headers));
  expect(options.method).toBe('POST'); expect(options.redirect).toBe('manual');
  expect(new Headers(options.headers).get('x-server-timeout')).toBe('7');
  expect(JSON.parse(String(options.body)).generationConfig).toEqual({ maxOutputTokens: 700 });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|offline-fake-key|Reply only/);
});

it.each([400, 429, 503])('never retries either transport on HTTP %i', async status => {
  const origin = vi.fn(async () => response(status)); const httpsSend = vi.fn(async () => response(status));
  const result = await compare(await prepare(), { originFetch: origin, httpsSend, diagnostic: geminiDiagnostic });
  expect(origin).toHaveBeenCalledTimes(1); expect(httpsSend).toHaveBeenCalledTimes(1);
  expect(result.every((item: { httpStatus: number }) => item.httpStatus === status)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
});
it('does not follow redirects on either transport', async () => {
  const origin = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://example.invalid/PRIVATE' } }));
  const httpsSend = vi.fn(async () => new Response('', { status: 302 }));
  const result = await compare(await prepare(), { originFetch: origin, httpsSend, diagnostic: geminiDiagnostic });
  expect(result.every((item: { diagnostic: string }) => item.diagnostic === 'redirect_refused')).toBe(true);
  expect(origin).toHaveBeenCalledTimes(1); expect(httpsSend).toHaveBeenCalledTimes(1);
});
it('has a separate seven-second deadline per transport with no third attempt', async () => {
  const prepared = await prepare();
  vi.useFakeTimers();
  const stall = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('PRIVATE')), { once: true })));
  const pending = compare(prepared, { originFetch: stall, httpsSend: stall, diagnostic: geminiDiagnostic });
  await vi.advanceTimersByTimeAsync(14000);
  const result = await pending;
  expect(stall).toHaveBeenCalledTimes(2);
  expect(result.map((item: { diagnostic: string }) => item.diagnostic)).toEqual(['timeout', 'timeout']);
});
it('reports a network failure safely and calls each path once', async () => {
  const failed = vi.fn(async () => { throw new Error('PRIVATE_KEY PRIVATE_TEXT'); });
  const result = await compare(await prepare(), { originFetch: failed, httpsSend: failed, diagnostic: geminiDiagnostic });
  expect(failed).toHaveBeenCalledTimes(2);
  expect(result.map((item: { diagnostic: string }) => item.diagnostic)).toEqual(['network_error', 'network_error']);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
});
