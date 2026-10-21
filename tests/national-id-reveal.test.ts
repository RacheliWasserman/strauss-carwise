import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ role: vi.fn(), request: vi.fn(), reveal: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/persistence-api-auth', () => ({ requireApiRole: mocks.role }));
vi.mock('@/lib/representative-request-repository', () => ({ getRequestForRepresentative: mocks.request }));
vi.mock('../src/lib/identity/identity-repository', () => ({ revealRequestNationalId: mocks.reveal }));

import { NextResponse } from 'next/server';
import { POST } from '../src/app/api/representative-requests/[requestId]/national-id/route';

const ME = 'a0000000-0000-4000-8000-0000000000a1';
const OTHER = 'b0000000-0000-4000-8000-0000000000b2';
const REQUEST = '18eff6aa-0000-4000-8000-000000000001';
const FULL_ID = '039337423';
const row = (extra: Record<string, unknown> = {}) => ({ id: REQUEST, conversation_id: 'c0000000-0000-4000-8000-000000000001', owner_user_id: 'e0000000-0000-4000-8000-000000000001',
  status: 'claimed', topic: 'שדה חסר: בונוס חודשי [bonus]', assigned_representative_id: ME, requested_at: '2026-10-21T10:00:00.000Z', claimed_at: '2026-10-21T10:05:00.000Z',
  answered_at: null, closed_at: null, created_at: '2026-10-21T10:00:00.000Z', updated_at: '2026-10-21T10:05:00.000Z', ...extra });
const call = (id = REQUEST, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/representative-requests/${id}/national-id`, { method: 'POST', headers }), { params: Promise.resolve({ requestId: id }) });
const logged = () => JSON.stringify([(console.info as ReturnType<typeof vi.fn>).mock.calls, (console.warn as ReturnType<typeof vi.fn>).mock.calls]);

let caller = 0;
let me = ME;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});vi.spyOn(console, 'warn').mockImplementation(() => {});
  // A distinct representative per test keeps the per-representative rate limit out of the way.
  me = `${ME.slice(0, -4)}${String(++caller).padStart(4, '0')}`;
  mocks.role.mockResolvedValue({ profile: { userId: me, role: 'representative' } });
  mocks.request.mockImplementation(async () => row({ assigned_representative_id: me }));
  mocks.reveal.mockResolvedValue(FULL_ID);
});

describe('full national ID: only the representative who claimed this request, only while claimed', () => {
  it('the assigned representative of a claimed request gets the full ID, uncached', async () => {
    const response = await call();
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ nationalId: FULL_ID });
    expect(response.headers.get('cache-control')).toContain('no-store');expect(response.headers.get('cache-control')).toContain('private');
    expect(mocks.reveal).toHaveBeenCalledWith(REQUEST);
    expect(logged()).not.toContain(FULL_ID);expect(logged()).not.toContain(FULL_ID.slice(-4));
  });

  it('refuses everyone else with one identical answer and never asks the database for the ID', async () => {
    // Answered, closed and cancelled requests stay assigned to this same representative: the status alone must refuse.
    const refusals: Array<[string, () => void]> = [
      ['unassigned (open) request', () => mocks.request.mockResolvedValue(row({ status: 'open', assigned_representative_id: null, claimed_at: null }))],
      ['request claimed by another representative', () => mocks.request.mockResolvedValue(row({ assigned_representative_id: OTHER }))],
      ['request hidden by RLS (another representative\'s)', () => mocks.request.mockResolvedValue(null)],
      ['answered request', () => mocks.request.mockResolvedValue(row({ status: 'answered', assigned_representative_id: me, answered_at: '2026-10-21T10:30:00.000Z' }))],
      ['closed request', () => mocks.request.mockResolvedValue(row({ status: 'closed', assigned_representative_id: me, closed_at: '2026-10-21T11:00:00.000Z' }))],
      ['cancelled request', () => mocks.request.mockResolvedValue(row({ status: 'cancelled', assigned_representative_id: me }))],
      ['repository failure', () => mocks.request.mockRejectedValue(new Error('db down'))]
    ];
    const bodies = new Set<string>();
    for (const [label, arrange] of refusals) {
      mocks.reveal.mockClear();arrange();
      const response = await call();
      expect(response.status, label).toBe(404);
      bodies.add(JSON.stringify(await response.json()));
      expect(mocks.reveal, label).not.toHaveBeenCalled();
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toMatch(/\d{4}/);
  });

  it('a status change between the check and the read is refused by the database the same way', async () => {
    mocks.reveal.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);expect(JSON.stringify(await response.json())).not.toContain(FULL_ID);
  });

  it('requires a representative session, a same-origin request and a valid request ID', async () => {
    mocks.role.mockResolvedValueOnce({ response: NextResponse.json({ error: 'נדרשת התחברות' }, { status: 401 }) });
    expect((await call()).status).toBe(401);
    mocks.role.mockResolvedValueOnce({ response: NextResponse.json({ error: 'אין הרשאה' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect((await call(REQUEST, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('not-a-uuid')).status).toBe(404);
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it('limits repeated reveals per representative', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) statuses.push((await call()).status);
    expect(statuses.slice(0, 20).every(status => status === 200)).toBe(true);expect(statuses[20]).toBe(429);
  });
});
