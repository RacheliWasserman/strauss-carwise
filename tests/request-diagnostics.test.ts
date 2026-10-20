import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { credentialSnapshot, geminiWireShape, keyFingerprint, geminiHeaderShape } from '../src/lib/ai/request-diagnostics';
import { buildContext } from '../src/lib/ai/context';
import { geminiDiagnostic } from '../src/lib/ai/gemini-diagnostics';
import type { ConversationMessageRow } from '../src/lib/conversation-repository';
it('compares runtime and file keys only using domain-separated fingerprints', () => {
  const file = () => ({ GEMINI_API_KEY: 'fictional-secret-for-offline-test', GEMINI_MODEL: 'gemini-3.5-flash-lite' });
  const snapshot = credentialSnapshot('fictional-secret-for-offline-test', undefined, file);
  expect(snapshot).toMatchObject({ keyPresent: true, runtimeKeyMatchesEnvLocal: true, runtimeModelMatchesEnvLocal: true });
  expect(snapshot.keyFingerprint).toMatch(/^[a-f0-9]{24}$/);
  expect(credentialSnapshot('a-different-test-secret', undefined, file).runtimeKeyMatchesEnvLocal).toBe(false);
  expect(credentialSnapshot('fictional-secret-for-offline-test', 'different-model', file).runtimeModelMatchesEnvLocal).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain('fictional-secret-for-offline-test');
  expect(keyFingerprint('')).toBeNull();
});
it('handles deployed environments without .env.local', () => {
  expect(credentialSnapshot('offline-key', undefined, () => { throw new Error('private path'); })).toMatchObject({ envLocalReadable: false, runtimeKeyMatchesEnvLocal: null });
});
it('reports only allowlisted non-sensitive header facts', () => {
  const result = geminiHeaderShape({ 'x-server-timeout': '7', 'content-type': 'application/json',
    'x-goog-api-key': 'private-key', authorization: 'Bearer private-token',
    'x-goog-api-client': 'google-genai-sdk/2.30.0', 'x-private-person': 'private-person' });
  expect(result).toMatchObject({ serverTimeoutSeconds: 7, contentTypeIsJson: true, sdkVersion: '2.30.0', apiKeyHeaderPresent: true, authorizationHeaderPresent: true });
  expect(JSON.stringify(result)).not.toMatch(/private|Bearer/);
});
it('reports Unicode risk counts without reporting characters or changing text', () => {
  const result = geminiWireShape({ contents: [{ role: 'user', parts: [{ text: 'שלום\u0000\uFFFD\u202E\uD800' }] }] });
  expect(result).toMatchObject({ controlCharCount: 1, replacementCharCount: 1, bidiControlCount: 1, illFormedMessageCount: 1 });
  expect(JSON.stringify(result)).not.toContain('שלום');
});
it('logs only request structure without any text, IDs or raw unknown field paths', () => {
  const result = geminiWireShape({ contents: [
    { role: 'user', parts: [{ text: 'private salary' }] }, { role: 'model', parts: [{ text: 'answer' }] },
    { role: 'user', parts: [{ text: 'question' }] }
  ], systemInstruction: { parts: [{ text: 'private instructions' }] }, generationConfig: { maxOutputTokens: 700 }, 'private-field': 'private-value' });
  expect(result).toMatchObject({ messageCount: 3, roles: ['user', 'model', 'user'], contentLengths: [14, 6, 8], maxOutputTokens: 700, illFormedMessageCount: 0 });
  expect(JSON.stringify(result)).not.toMatch(/salary|instructions|private-field|private-value/);
});
it('never splits a surrogate pair at per-message or total context boundaries', () => {
  const row = (body: string) => ({ sender_type: 'employee', body }) as ConversationMessageRow;
  const first = buildContext([row('a'.repeat(3999) + '😀')]);
  expect(first[0].content).toBe('a'.repeat(3999));
  const total = buildContext([row('ab😀'), ...Array.from({ length: 4 }, () => row('x'.repeat(3999))), row('z')]);
  expect(total[0].content).toBe('ab');
  for (const message of [...first, ...total]) expect(Buffer.from(message.content).toString('utf8')).toBe(message.content);
});
it('classifies known error fields without echoing indices, descriptions or arbitrary names', () => {
  const result = geminiDiagnostic(new Error(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'invalid', details: [
    { fieldViolations: [{ field: 'generation_config.max_output_tokens' }, { field: 'contents[8].parts[2].text', description: 'private salary' }] }
  ] } })));
  expect(result.fieldCodes).toEqual(['contents.parts.text', 'generationConfig.maxOutputTokens']);
  expect(JSON.stringify(result)).not.toMatch(/private|salary|\[8\]/);
});
