import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { geminiDiagnostic } from '../src/lib/ai/gemini-diagnostics';
const envelope = { error: { status: 'INVALID_ARGUMENT', message: 'Unsupported model for generateContent: PRIVATE' } };
it.each([
  { value: new Error(JSON.stringify(envelope)) },
  { value: new Error('got status: 400. ' + JSON.stringify(envelope)) },
  { value: { response: { data: envelope } } },
  { value: new Error('wrapper', { cause: new Error(JSON.stringify(envelope)) }) }
])('unwraps supported SDK/error shapes without returning raw text: %j', ({ value }) => {
  const result = geminiDiagnostic(value);
  expect(result).toMatchObject({ googleStatus: 'INVALID_ARGUMENT', detail: 'model_unavailable' });
  expect(result.envelopeShape).not.toBe('not_recognized');
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('distinguishes a parsed but unknown Google message from an unrecognized envelope', () => {
  expect(geminiDiagnostic(new Error(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'Something unknown PRIVATE' } })))).toMatchObject({ googleStatus: 'INVALID_ARGUMENT', detail: 'unclassified', envelopeShape: 'google_error' });
  expect(geminiDiagnostic(new Error('PRIVATE'))).toMatchObject({ googleStatus: 'unknown', detail: 'unclassified', envelopeShape: 'not_recognized' });
});
it('bounds malformed, oversized and cyclic wrappers', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.cause = cyclic;
  for (const input of [cyclic, null, new Error('{invalid'), new Error('x'.repeat(70000))]) {
    expect(geminiDiagnostic(input).detail).toBe('unclassified');
  }
});
it.each([
  { status: 'INVALID_ARGUMENT', message: 'Manually set deadline 7s is too short. Minimum allowed deadline is 10s. private' },
  { status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.', details: [{ fieldViolations: [{ field: 'private-field', description: 'deadline is too short private' }] }] }
])('classifies short deadlines without printing the Google message', error => {
  const result = geminiDiagnostic(new Error(JSON.stringify({ error })));
  expect(result.detail).toBe('deadline_too_short');
  expect(JSON.stringify(result)).not.toContain('private');
});
