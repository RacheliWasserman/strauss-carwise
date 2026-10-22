import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authOrigin } from '../src/lib/auth-origin';

const mocks = vi.hoisted(() => ({ signup: vi.fn(), exchange: vi.fn(), user: vi.fn(), role: vi.fn(), inUse: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ createSupabaseServerClient: async () => ({
  auth: { signUp: mocks.signup, exchangeCodeForSession: mocks.exchange, getUser: mocks.user },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.role }) }) })
}) }));
vi.mock('../src/lib/identity/identity-repository', () => ({
  nationalIdInUse: mocks.inUse, createIdentityForNewUser: vi.fn(), deleteNewAuthUser: vi.fn()
}));
import { POST } from '../src/app/api/auth/register/route';
import { GET } from '../src/app/auth/callback/route';

const site = 'https://strauss-carwise.vercel.app';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_SITE_URL', site);
  vi.stubEnv('VERCEL_ENV', 'production');
  mocks.inUse.mockResolvedValue(false);
  mocks.signup.mockResolvedValue({ data: { user: null, session: null }, error: null });
  mocks.exchange.mockResolvedValue({ error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: 'test-user' } } });
  mocks.role.mockResolvedValue({ data: { role: 'employee' }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('canonical auth origin', () => {
  it('uses the configured production origin even behind a localhost proxy', () => {
    expect(authOrigin('http://localhost:3000/api/auth/register')).toBe(site);
  });
  it('uses the Vercel production domain when explicit configuration is absent', () => {
    expect(authOrigin('http://localhost:3000/', { NODE_ENV: 'production', VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'strauss-carwise.vercel.app' })).toBe(site);
  });
  it('preserves local development when no canonical origin is configured', () => {
    expect(authOrigin('http://localhost:3000/register', { NODE_ENV: 'test' })).toBe('http://localhost:3000');
  });
  it.each(['http://localhost:3000', 'https://localhost', 'https://127.0.0.1', 'https://example.com/path',
    'https://example.com?next=bad', 'https://user:password@example.com', 'javascript:bad'])('rejects unsafe production configuration %#', value => {
    expect(() => authOrigin(site, { NODE_ENV: 'production', VERCEL_ENV: 'production', APP_SITE_URL: value })).toThrow();
  });
  it('fails closed if production domain configuration is missing', () => {
    expect(() => authOrigin('http://localhost:3000', { NODE_ENV: 'production', VERCEL_ENV: 'production' })).toThrow();
  });
});

describe('signup and callback route regression', () => {
  const signup = () => POST(new Request('http://localhost:3000/api/auth/register', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test@example.com', password: 'test-password-only',
      firstName: 'בדיקה', lastName: 'בדיקה', nationalId: '000000018' }) }));
  it('passes the exact production callback to Supabase signUp', async () => {
    expect((await signup()).status).toBe(200);
    expect(mocks.signup.mock.calls[0][0].options.emailRedirectTo).toBe(site + '/auth/callback');
  });
  it('does not create users with an invalid production origin', async () => {
    vi.stubEnv('APP_SITE_URL', 'http://localhost:3000');
    expect((await signup()).status).toBe(503);
    expect(mocks.signup).not.toHaveBeenCalled();
    expect(mocks.inUse).not.toHaveBeenCalled();
  });
  it('exchanges a code and redirects to the canonical site without copying the code', async () => {
    const response = await GET(new Request('http://localhost:3000/auth/callback?code=synthetic-test-code'));
    expect(mocks.exchange).toHaveBeenCalledWith('synthetic-test-code');
    expect(response.headers.get('location')).toBe(site + '/');
  });
  it('retains representative routing', async () => {
    mocks.role.mockResolvedValue({ data: { role: 'representative' }, error: null });
    const response = await GET(new Request(site + '/auth/callback?code=synthetic-test-code'));
    expect(response.headers.get('location')).toBe(site + '/representative');
  });
  it('handles missing and rejected codes safely', async () => {
    const missing = await GET(new Request(site + '/auth/callback'));
    expect(missing.headers.get('location')).toBe(site + '/login?error=callback');
    expect(mocks.exchange).not.toHaveBeenCalled();
    mocks.exchange.mockResolvedValue({ error: { message: 'synthetic failure' } });
    const failed = await GET(new Request(site + '/auth/callback?code=synthetic-test-code'));
    expect(failed.headers.get('location')).toBe(site + '/login?error=callback');
  });
});
