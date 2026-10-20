import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ from: vi.fn(), legacyFrom: vi.fn(), adminFrom: vi.fn(), server: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.legacyFrom } }));
vi.mock('../src/lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.adminFrom } }));
vi.mock('../src/lib/supabase-server', () => ({ createSupabaseServerClient: mocks.server }));
import { searchAdvisorVehicles, AdvisorCatalogDataError } from '../src/lib/advisor-catalog-service';
import { advisorVehicleSearchSchema, parseAdvisorVehicleSearch } from '../src/lib/advisor-data-validation';
import { getVehicles } from '../src/lib/vehicle-repository';

const row = (id = 'CAT-001') => ({ id, display_name: 'Fictional Model', manufacturer_name: 'Example Manufacturer', group_code: 'א', drive_type: 'חשמלי', active: true });
function builder(data: unknown, error: unknown = null) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'order', 'ilike', 'gt', 'limit']) query[method] = vi.fn(() => query);
  query.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve));
  return query;
}
beforeEach(() => { vi.resetAllMocks(); mocks.server.mockResolvedValue({ from: mocks.from }); });

describe('authenticated vehicle catalog repository and service', () => {
  it('uses only the supplied session client, applies all filters and projects public fields', async () => {
    const query = builder([{ ...row(), monthly_company_cost: 9999, default_employee_participation: 123, private_salary: 50000 }]);
    mocks.from.mockReturnValue(query);
    const result = await searchAdvisorVehicles({ name: 'Model', manufacturer: 'Example', group: 'א', driveType: 'חשמלי', limit: 20 });
    expect(mocks.from).toHaveBeenCalledWith('vehicle_catalog');
    expect(query.select).toHaveBeenCalledWith('id, display_name, manufacturer_name, group_code, drive_type, active');
    expect(query.eq.mock.calls).toEqual([['active', true], ['group_code', 'א'], ['drive_type', 'חשמלי']]);
    expect(query.ilike.mock.calls).toEqual([['display_name', '%Model%'], ['manufacturer_name', '%Example%']]);
    expect(query.order).toHaveBeenCalledWith('id');
    expect(query.limit).toHaveBeenCalledWith(21);
    expect(result).toEqual({ vehicles: [{ id: 'CAT-001', display_name: 'Fictional Model', manufacturer_name: 'Example Manufacturer', group_code: 'א', drive_type: 'חשמלי' }], match: 'single', hasMore: false, nextCursor: null });
    expect(JSON.stringify(result)).not.toMatch(/9999|private_salary|participation|active/);
    expect(mocks.adminFrom).not.toHaveBeenCalled(); expect(mocks.legacyFrom).not.toHaveBeenCalled();
  });
  it('escapes literal LIKE wildcards without interpolated OR filters', async () => {
    const query = builder([]); mocks.from.mockReturnValue(query);
    await searchAdvisorVehicles({ name: '50%_\\test', limit: 20 });
    expect(query.ilike).toHaveBeenCalledWith('display_name', '%50\\%\\_\\\\test%');
  });
  it('returns a valid empty result without inventing a match', async () => {
    mocks.from.mockReturnValue(builder([]));
    expect(await searchAdvisorVehicles({ limit: 20 })).toEqual({ vehicles: [], match: 'none', hasMore: false, nextCursor: null });
  });
  it('runs an empty URL query through parsing/service/repository as the first active page', async () => {
    const query = builder([row()]); mocks.from.mockReturnValue(query);
    const parsed = parseAdvisorVehicleSearch(new URLSearchParams());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('Unexpected invalid empty query');
    expect((await searchAdvisorVehicles(parsed.data)).vehicles).toHaveLength(1);
    expect(query.limit).toHaveBeenCalledWith(21);
    expect(query.eq.mock.calls).toEqual([['active', true]]);
    expect(query.ilike).not.toHaveBeenCalled(); expect(query.gt).not.toHaveBeenCalled();
  });
  it('keeps multiple same-name vehicles distinct and paginates by real text IDs', async () => {
    const query = builder([row('CAT-002'), row('CAT-003')]); mocks.from.mockReturnValue(query);
    expect(await searchAdvisorVehicles({ afterId: 'CAT-001', limit: 1 })).toMatchObject({ vehicles: [expect.objectContaining({ id: 'CAT-002' })], match: 'multiple', hasMore: true, nextCursor: 'CAT-002' });
    expect(query.gt).toHaveBeenCalledWith('id', 'CAT-001'); expect(query.limit).toHaveBeenCalledWith(2);
  });
  it.each([
    { id: null }, { id: '' }, { id: ' CAT-001 ' }, { display_name: null }, { display_name: '  ' },
    { manufacturer_name: '' }, { group_code: 'unknown' }, { drive_type: null }, { active: false }
  ])('rejects incomplete/invalid catalog data: %j', async patch => {
    mocks.from.mockReturnValue(builder([{ ...row(), ...patch }]));
    await expect(searchAdvisorVehicles({ limit: 20 })).rejects.toBeInstanceOf(AdvisorCatalogDataError);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });
  it('rejects duplicate IDs rather than fabricating identifiers or silently merging records', async () => {
    mocks.from.mockReturnValue(builder([row(), row()]));
    await expect(searchAdvisorVehicles({ limit: 20 })).rejects.toBeInstanceOf(AdvisorCatalogDataError);
  });
  it('does not bypass RLS denial with an admin/anonymous retry', async () => {
    mocks.from.mockReturnValue(builder(null, { code: '42501', message: 'private database detail' }));
    await expect(searchAdvisorVehicles({ limit: 20 })).rejects.toThrow('Vehicle catalog unavailable');
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.adminFrom).not.toHaveBeenCalled(); expect(mocks.legacyFrom).not.toHaveBeenCalled();
  });
  it('preserves the legacy getVehicles entry point and full projection', async () => {
    const query = builder([row()]); mocks.legacyFrom.mockReturnValue(query);
    expect(await getVehicles()).toEqual([row()]);
    expect(query.select).toHaveBeenCalledWith('*');
    expect(query.eq).toHaveBeenCalledWith('active', true);
    expect(mocks.server).not.toHaveBeenCalled();
  });
});

it.each([{ name: '' }, { group: 'ה' }, { limit: 0 }, { limit: 51 }, { name: 'x'.repeat(121) }, { driveType: '\u0000' }, { employeeId: 'demo' }])('rejects invalid search parameters %j', params => {
  expect(advisorVehicleSearchSchema.safeParse(params).success).toBe(false);
});
