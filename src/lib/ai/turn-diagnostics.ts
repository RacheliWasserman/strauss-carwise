import { ZodError } from 'zod';
import { ProviderFailure } from './providers';

// Our own thrown messages are code constants, safe to log. Anything else is reported only by class.
const KNOWN_MESSAGES = ['Invalid advisor scope', 'Invalid advisor state scope', 'Invalid local advisor scope', 'Unknown occupation candidate',
  'Operation lacks source evidence', 'Group lacks source evidence', 'Occupation lacks source evidence', 'Invalid occupation choice',
  'Foreign employee profile', 'Confirmed profile expected', 'Catalog reply too large', 'AI storage unavailable'];

/** Sanitized error shape: never values, message bodies, salaries or upstream texts. */
export function describeTurnError(error: unknown) {
  const stage = typeof error === 'object' && error !== null && 'advisorStage' in error ? String((error as { advisorStage: unknown }).advisorStage) : undefined;
  const base = { stage: stage && /^[a-z_]{1,40}$/.test(stage) ? stage : undefined };
  if (error instanceof ProviderFailure) return { ...base, errorClass: 'ProviderFailure', reason: error.reason, retryable: error.retryable };
  if (error instanceof ZodError) {
    // Schema field names and issue codes only; array indexes are collapsed.
    return { ...base, errorClass: 'ZodError', issues: error.issues.slice(0, 5).map(issue => ({
      path: issue.path.map(part => typeof part === 'number' ? '#' : String(part)).join('.').replace(/[^\w.#]/g, '').slice(0, 80),
      code: issue.code })) };
  }
  if (error instanceof Error) {
    const known = KNOWN_MESSAGES.find(message => error.message === message);
    return { ...base, errorClass: /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error', message: known ?? 'unlisted' };
  }
  return { ...base, errorClass: 'non_error' };
}
