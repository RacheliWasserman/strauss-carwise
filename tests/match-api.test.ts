import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ profile: vi.fn(), context: vi.fn(), search: vi.fn() }));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/lib/match/match-service', () => ({ loadMatchContext: mocks.context }));
vi.mock('@/lib/match/match-engine', async () => import('../src/lib/match/match-engine'));
vi.mock('../src/lib/advisor-catalog-service', () => ({ searchAdvisorVehicles: mocks.search }));
vi.mock('../src/lib/employee-data-repository', () => ({ getLatestConfirmedEmployeeData: vi.fn() }));
vi.mock('../src/lib/occupation-repository', () => ({ listAdvisorOccupations: vi.fn() }));
vi.mock('../src/lib/rules-repository', () => ({ getCalculationRules: vi.fn() }));
import { POST } from '../src/app/api/match/route';
import { resolveComparisonIntent } from '../src/lib/catalog/showroom-service';
import type { MatchCandidate } from '../src/lib/match/match-engine';

const call = (body: unknown, headers: Record<string, string> = {}) => POST(new Request('http://localhost/api/match', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const candidate = (id: string, delta: number): MatchCandidate => ({ id, display_name: id, manufacturer_name: 'יצרן', group_code: 'ב', drive_type: 'חשמלי',
  eligibilityReason: 'בקבוצה', family: false, current: false, financial: { status: 'estimate', delta, electricBonus: 250, familyShare: 0 } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.profile.mockResolvedValue({ userId: 'server-user', role: 'employee' });
  mocks.context.mockResolvedValue({ status: 'ready', candidates: [candidate('CAR-08', 300), candidate('CAR-06', 500)], powertrains: ['חשמלי'],
    basis: { occupation: 'אנליסט/ית נתונים', group: 'ב' }, notes: ['זמני'], rulesVersion: 'v' });
});

it('denies unauthenticated and representative requests before reading any data', async () => {
  mocks.profile.mockResolvedValueOnce(null);
  expect((await call({ preferences: { powertrain: 'any' } })).status).toBe(401);
  mocks.profile.mockResolvedValueOnce({ userId: 'rep', role: 'representative' });
  expect((await call({ preferences: { powertrain: 'any' } })).status).toBe(403);
  expect(mocks.context).not.toHaveBeenCalled();
});

it('rejects a cross-origin request before authentication', async () => {
  expect((await call({ preferences: { powertrain: 'any' } }, { origin: 'https://untrusted.example' })).status).toBe(403);
  expect(mocks.profile).not.toHaveBeenCalled();
});

it('never accepts identity, eligibility or values from the client', async () => {
  for (const body of [{ preferences: { powertrain: 'any' }, userId: 'someone-else' }, { preferences: { powertrain: 'any', eligible: true } },
    { preferences: { powertrain: 'any' }, candidates: [candidate('CAR-14', 9999)] }, { preferences: { powertrain: 'חשמלי' } }, 'not json', 'x'.repeat(2000)]) {
    expect((await call(body)).status).toBe(400);
  }
  expect(mocks.context).not.toHaveBeenCalled();
});

it('ranks only the server-loaded candidates of the signed-in employee', async () => {
  const response = await call({ preferences: { powertrain: 'any' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mocks.context).toHaveBeenCalledWith('server-user');
  const data = await response.json();
  expect(data.outcome.recommendations.map((item: { vehicle: { id: string } }) => item.vehicle.id)).toEqual(['CAR-06', 'CAR-08']);
  expect(data.question).toBeNull();
  expect(JSON.stringify(data)).not.toContain('rulesVersion');
});

it('passes the confirmation-flow answer through and hides internal failures', async () => {
  mocks.context.mockResolvedValueOnce({ status: 'needs_profile', reason: 'צריך פרופיל מאושר' });
  expect(await (await call({ preferences: { powertrain: 'any' } })).json()).toEqual({ status: 'needs_profile', reason: 'צריך פרופיל מאושר' });
  mocks.context.mockRejectedValueOnce(new Error('private salary detail'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failed = await call({ preferences: { powertrain: 'any' } });
  expect(failed.status).toBe(503);
  expect(JSON.stringify(await failed.json())).not.toContain('salary');
});

it('opens a chat comparison only for 2–3 distinct active catalog vehicles', async () => {
  mocks.search.mockResolvedValue({ vehicles: [{ id: 'CAR-06', display_name: 'MG4', manufacturer_name: 'מ.ג', group_code: 'ב', drive_type: 'חשמלי' },
    { id: 'CAR-08', display_name: 'KONA EV', manufacturer_name: 'יונדאי', group_code: 'ב', drive_type: 'חשמלי' }], hasMore: false, nextCursor: null });
  expect(await resolveComparisonIntent('CAR-06,CAR-08')).toEqual([{ id: 'CAR-06', display_name: 'MG4' }, { id: 'CAR-08', display_name: 'KONA EV' }]);
  for (const value of ['CAR-06', 'CAR-06,CAR-06', 'CAR-06,CAR-99', 'CAR-06,CAR-08,CAR-01,CAR-02', 'CAR-06,<script>', undefined, ['CAR-06', 'CAR-08']]) {
    expect(await resolveComparisonIntent(value as string)).toBeUndefined();
  }
});

it('answers rapid repeated requests independently, each for the signed-in employee only', async () => {
  const body = { preferences: { powertrain: 'any', travelers: 'couple', priorities: ['cost'], charging: ['home'], finance: 'balanced' } };
  const responses = await Promise.all(Array.from({ length: 5 }, () => call(body)));
  const payloads = await Promise.all(responses.map(response => response.json()));
  expect(responses.every(response => response.status === 200)).toBe(true);
  expect(new Set(payloads.map(payload => JSON.stringify(payload))).size).toBe(1);
  expect(mocks.context.mock.calls.every(([userId]) => userId === 'server-user')).toBe(true);
});

it('rejects forged lifestyle fields before reading any data', async () => {
  for (const preferences of [{ powertrain: 'any', priorities: ['cost', 'city', 'energy', 'technology'] }, { powertrain: 'any', seats: '9' },
    { powertrain: 'any', seats: '7', seatsStrength: 'hard', group: 'ד' }, { powertrain: 'any', trunkLiters: 900 }]) {
    expect((await call({ preferences })).status).toBe(400);
  }
  expect(mocks.context).not.toHaveBeenCalled();
});
