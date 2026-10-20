import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ profile: vi.fn(), search: vi.fn(), DataError: class extends Error {} }));
vi.mock('../src/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/lib/persistence-api-auth', async () => import('../src/lib/persistence-api-auth'));
vi.mock('@/lib/advisor-data-validation', async () => import('../src/lib/advisor-data-validation'));
vi.mock('@/lib/advisor-catalog-service', () => ({ searchAdvisorVehicles: mocks.search, AdvisorCatalogDataError: mocks.DataError }));
import { GET } from '../src/app/api/advisor/vehicles/route';
const request = (query = '') => new Request(`http://localhost/api/advisor/vehicles${query}`);
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetAllMocks();
  mocks.profile.mockResolvedValue({ userId: 'authenticated-employee', role: 'employee' });
  mocks.search.mockResolvedValue({ vehicles: [], match: 'none', hasMore: false, nextCursor: null });
});
it('denies anonymous reads before querying the catalog', async () => {
  mocks.profile.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
  expect(mocks.search).not.toHaveBeenCalled();
});
it('denies representative access to this employee-only API', async () => {
  mocks.profile.mockResolvedValue({ userId: 'rep', role: 'representative' });
  expect((await GET(request())).status).toBe(403);
  expect(mocks.search).not.toHaveBeenCalled();
});
it('accepts combined filters, normalizes query whitespace and disables caching', async () => {
  const query = new URLSearchParams({ name: '  Model  ', manufacturer: 'Example', group: 'א', driveType: 'חשמלי', limit: '5', afterId: 'CAT-001' });
  const response = await GET(request('?' + query));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mocks.search).toHaveBeenCalledWith({ name: 'Model', manufacturer: 'Example', group: 'א', driveType: 'חשמלי', limit: 5, afterId: 'CAT-001' });
  expect((await response.json()).match).toBe('none');
});
it.each(['', '?'])('accepts a first-page URL with no parameters (%s) and applies only limit:20', async suffix => {
  const result = { vehicles: [{ id: 'CAT-FIXTURE', display_name: 'Fictional Vehicle', manufacturer_name: 'Fixture Maker', group_code: 'א', drive_type: 'חשמלי' }], match: 'single', hasMore: false, nextCursor: null };
  mocks.search.mockResolvedValue(result);
  const response = await GET(request(suffix));
  expect(response.status).toBe(200);
  expect(mocks.search).toHaveBeenCalledWith({ limit: 20 });
  expect(await response.json()).toEqual(result);
});
it('accepts manufacturer search without an explicit limit or other optional fields', async () => {
  expect((await GET(request('?manufacturer=Toyota'))).status).toBe(200);
  expect(mocks.search).toHaveBeenCalledWith({ manufacturer: 'Toyota', limit: 20 });
});
it('rejects q as an undocumented parameter without silently changing search semantics', async () => {
  const response = await GET(request('?q=Toyota'));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'INVALID_VEHICLE_SEARCH_QUERY', issues: [{ field: 'query', reason: 'unknown_parameter' }] });
  expect(mocks.search).not.toHaveBeenCalled();
});
it.each(['?limit=', '?limit=null', '?limit=0', '?limit=1&limit=2', '?manufacturer='])('does not replace invalid explicit values with defaults: %s', async query => {
  expect((await GET(request(query))).status).toBe(400);
  expect(mocks.search).not.toHaveBeenCalled();
});
it('does not echo invalid search values or unknown parameter names', async () => {
  const response = await GET(request('?private-personal-parameter=private-value'));
  expect(JSON.stringify(await response.json())).not.toMatch(/private-personal|private-value/);
});
it('logs only bounded parameter names and sanitized issues, never values or authentication headers', async () => {
  const req = new Request('http://localhost/api/advisor/vehicles?unexpected=private-value', {
    headers: { cookie: 'session=private-cookie', authorization: 'Bearer private-token' }
  });
  expect((await GET(req)).status).toBe(400);
  expect(console.warn).toHaveBeenCalledWith('[carwise.catalog.query]', {
    parameterNames: ['unexpected'], issues: [{ field: 'query', reason: 'unknown_parameter' }]
  });
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private-value|private-cookie|private-token/);
});
it.each(['?employeeId=demo', '?userId=another-user', '?active=false', '?name=a&name=b', '?limit=51', '?group=unknown', '?name=', '?limit=abc', '?__proto__=x'])('rejects unknown/duplicate/invalid parameters without querying: %s', async query => {
  expect((await GET(request(query))).status).toBe(400);
  expect(mocks.search).not.toHaveBeenCalled();
});
it('returns a sanitized error on repository/network failures', async () => {
  mocks.search.mockRejectedValue(new Error('private salary token database SQL details'));
  const response = await GET(request());
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.code).toBe('VEHICLE_CATALOG_UNAVAILABLE');
  expect(JSON.stringify(body)).not.toMatch(/salary|token|SQL/);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
it('distinguishes invalid catalog data without exposing the malformed record', async () => {
  mocks.search.mockRejectedValue(new mocks.DataError('private record'));
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe('VEHICLE_CATALOG_INVALID_DATA');
});
it('handles authentication infrastructure errors without querying the catalog', async () => {
  mocks.profile.mockRejectedValue(new Error('private auth token'));
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('private auth token');
  expect(mocks.search).not.toHaveBeenCalled();
});
