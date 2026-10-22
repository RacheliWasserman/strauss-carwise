import * as React from 'react';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ user: vi.fn(), role: vi.fn(), table: vi.fn(), filter: vi.fn() }));
function client() {
  return { auth: { getUser: mocks.user }, from: (table: string) => {
    mocks.table(table);
    return { select: () => ({ eq: (column: string, id: string) => {
      mocks.filter(column, id); return { maybeSingle: mocks.role };
    } }) };
  } };
}
vi.mock('server-only', () => ({}));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => client() }));
vi.mock('../src/lib/supabase-server', () => ({ createSupabaseServerClient: async () => client() }));
vi.mock('@/lib/require-authenticated-user', () => import('../src/lib/require-authenticated-user'));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock('@/components/logout-button', () => ({ LogoutButton: () => null }));
vi.mock('@/components/brand/brand-lockup', () => ({ BrandLockup: () => null }));
vi.mock('@/components/representative/representative-console', () => ({ RepresentativeConsole: () => null }));
import { middleware } from '../src/middleware';
import { getAuthenticatedProfile } from '../src/lib/require-authenticated-user';
import RepresentativePage from '../src/app/representative/page';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('React', React);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.example');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test-placeholder');
  // Metadata deliberately disagrees: the database role is authoritative.
  mocks.user.mockResolvedValue({ data: { user: { id: 'test-user', user_metadata: { role: 'representative' } } }, error: null });
  mocks.role.mockResolvedValue({ data: { role: 'employee' }, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const visit = () => middleware(new NextRequest('http://localhost:3000/'));

describe.each(['development', 'test', 'production'] as const)('root role routing in %s', environment => {
  it.each(['employee', 'representative'] as const)('sends %s to its current interface, never the demo', async role => {
    vi.stubEnv('NODE_ENV', environment);
    mocks.role.mockResolvedValue({ data: { role }, error: null });
    expect((await visit()).headers.get('location')).toBe(`http://localhost:3000/${role}`);
    expect(mocks.table).toHaveBeenCalledWith('user_profiles');
    expect(mocks.filter).toHaveBeenCalledWith('id', 'test-user');
  });
});

describe('refresh, session changes, and server authorization', () => {
  it('refreshing the root keeps a representative out of the legacy demo', async () => {
    mocks.role.mockResolvedValue({ data: { role: 'representative' }, error: null });
    for (let i = 0; i < 2; i++) expect((await visit()).headers.get('location')).toBe('http://localhost:3000/representative');
  });
  it('a signed-out request goes to login and a later representative session is routed correctly', async () => {
    mocks.user.mockResolvedValueOnce({ data: { user: null }, error: null });
    expect((await visit()).headers.get('location')).toBe('http://localhost:3000/login');
    mocks.role.mockResolvedValue({ data: { role: 'representative' }, error: null });
    expect((await visit()).headers.get('location')).toBe('http://localhost:3000/representative');
  });
  it.each([{ data: null, error: null }, { data: { role: 'admin' }, error: null }, { data: null, error: { code: '42501' } }])('fails closed for missing, invalid or unreadable profiles %#', async result => {
    mocks.role.mockResolvedValue(result);
    expect((await visit()).headers.get('location')).toBe('http://localhost:3000/login?error=profile');
    expect(await getAuthenticatedProfile()).toBeNull();
  });
  it('reads the server role from user_profiles, not user metadata', async () => {
    expect(await getAuthenticatedProfile()).toEqual({ userId: 'test-user', role: 'employee' });
  });
  it('the representative page rejects employees independently of middleware', async () => {
    await expect(RepresentativePage()).rejects.toThrow('redirect:/employee');
  });
  it('the representative page rejects signed-out sessions', async () => {
    mocks.user.mockResolvedValue({ data: { user: null }, error: null });
    await expect(RepresentativePage()).rejects.toThrow('redirect:/login');
  });
  it('the representative page accepts the database representative role', async () => {
    mocks.role.mockResolvedValue({ data: { role: 'representative' }, error: null });
    expect(React.isValidElement(await RepresentativePage())).toBe(true);
  });
});
