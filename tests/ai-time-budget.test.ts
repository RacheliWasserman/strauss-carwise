import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { AI_LIMITS } from '../src/lib/ai/config';
it('leaves API and lease headroom for one bounded three-provider attempt', () => {
  const route = readFileSync(new URL('../src/app/api/conversations/[conversationId]/assistant/route.ts', import.meta.url), 'utf8');
  const apiLimitMs = Number(route.match(/export const maxDuration = (\d+)/)?.[1]) * 1000;
  const chainMs = AI_LIMITS.geminiTimeoutMs + 2 * AI_LIMITS.providerTimeoutMs;
  expect(chainMs).toBe(34000);
  expect(apiLimitMs).toBe(60000);
  expect(chainMs).toBeLessThan(50000);
  expect(50000).toBeLessThan(apiLimitMs);
  expect(apiLimitMs).toBeLessThan(AI_LIMITS.leaseMs);
  expect(AI_LIMITS.maxTurnAttempts).toBe(3);
});
