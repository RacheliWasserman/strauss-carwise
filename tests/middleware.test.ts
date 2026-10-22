import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), role: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.getUser },
  from: (table: string) => { mocks.from(table); return { select: () => ({ eq: () => ({ maybeSingle: mocks.role }) }) }; } }) }));
import { middleware } from '../src/middleware';

const visit = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));
const location = (response: Response) => response.headers.get('location');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'test-user' } } });
  mocks.role.mockResolvedValue({ data: { role: 'employee' }, error: null });
});

describe('middleware: one auth check per navigation', () => {
  it('sends a signed-out visitor to sign in', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect(location(await visit('/catalog'))).toBe('http://localhost:3000/login');
    expect(location(await visit('/profile'))).toBe('http://localhost:3000/login');
  });
  it('does not repeat the role read on pages that check the role themselves', async () => {
    for (const path of ['/employee', '/catalog', '/match', '/profile', '/representative', '/complete-profile']) {
      const response = await visit(path);
      expect(location(response), path).toBeNull();
    }
    expect(mocks.getUser).toHaveBeenCalledTimes(6);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('still routes the root page by role, and reports a missing profile', async () => {
    expect(location(await visit('/'))).toBe('http://localhost:3000/employee');
    expect(mocks.from).toHaveBeenCalledWith('user_profiles');
    mocks.role.mockResolvedValue({ data: null, error: null });
    expect(location(await visit('/'))).toBe('http://localhost:3000/login?error=profile');
  });
  it('leaves API routes and sign-in pages to their own checks', async () => {
    for (const path of ['/api/profile', '/login', '/register', '/auth/callback']) expect(location(await visit(path))).toBeNull();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});
