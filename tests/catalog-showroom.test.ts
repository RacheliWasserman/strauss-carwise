import { existsSync, readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // vehicle-repository imports the shared Supabase client, which requires these (dummy values; nothing is called).
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||= 'test-publishable-key';
  process.env.SUPABASE_SECRET_KEY ||= 'test-only-secret';
  return { search: vi.fn(), profile: vi.fn(), occupations: vi.fn(), rules: vi.fn() };
});
vi.mock('server-only', () => ({}));
vi.mock('../src/lib/advisor-catalog-service', () => ({ searchAdvisorVehicles: mocks.search }));
vi.mock('../src/lib/employee-data-repository', () => ({ getLatestConfirmedEmployeeData: mocks.profile }));
vi.mock('../src/lib/occupation-repository', () => ({ listAdvisorOccupations: mocks.occupations }));
vi.mock('../src/lib/rules-repository', () => ({ getCalculationRules: mocks.rules }));

import { loadShowroom, resolveVehicleIntent } from '../src/lib/catalog/showroom-service';
import {
  EMPTY_FILTERS, eligibilityLabel, filterOptions, filterVehicles, groupLabel, netImpactHref, propulsion, vehicleEligibility, type ShowroomVehicle
} from '../src/lib/catalog/showroom';
import { VEHICLE_PHOTOS } from '../src/lib/catalog/vehicle-media';
import { searchVehicles } from '../src/lib/vehicle-repository';
import { vehiclesMentioned } from '../src/lib/ai/vehicle-selection';
import { selectCardMessage } from '../src/components/chat/catalog-cards';
import { CatalogBrowser } from '../src/components/catalog/catalog-browser';
import { VehiclePhoto } from '../src/components/catalog/vehicle-photo';
import type { Showroom } from '../src/lib/catalog/showroom-service';

/**
 * The company catalog fixture (data/cars.json, the same catalog the database was loaded from) stands in for the
 * active catalog the app reads from Supabase; the app itself never contains a vehicle list.
 */
type CarJson = Record<string, string | number>;
const CATALOG: ShowroomVehicle[] = (JSON.parse(readFileSync('data/cars.json', 'utf8')) as CarJson[]).map(car => ({
  id: String(car['מזהה']), display_name: String(car['דגם (כינוי מסחרי)']), manufacturer_name: String(car['תוצר']),
  group_code: car['קבוצה'] as ShowroomVehicle['group_code'], drive_type: String(car['הנעה'])
}));
const RULES = JSON.parse(readFileSync('data/rules.json', 'utf8'));
const USER = '0b6c1d0e-4a59-4a3c-9f0f-6a1f2d9e7a11';
/** The existing paged catalog service, returning the fixture in pages of `limit`. */
const pagedSearch = (rows: ShowroomVehicle[]) => async ({ limit, afterId }: { limit: number; afterId?: string }) => {
  const start = afterId ? rows.findIndex(row => row.id === afterId) + 1 : 0;
  const page = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  return { vehicles: page, hasMore, nextCursor: hasMore ? page.at(-1)!.id : null, match: 'multiple' };
};
const occupation = (title: string, group_code: string) => ({ title, group_code, car_mandatory: false, waiver_allowed: true, waiver_maintenance_amount: 0, key: title });
const confirmed = (occupation_title: string, eligible_children_count = 0) => ({ occupation_title, eligible_children_count, status: 'confirmed' });
const byId = (id: string) => CATALOG.find(vehicle => vehicle.id === id)!;
const confirmedBasis = (group: 'א' | 'ב' | 'ג' | 'ד', children = 0) => ({ kind: 'confirmed' as const, occupation: 'מנהל/ת מוצר', group, children });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.search.mockImplementation(pagedSearch(CATALOG));
  mocks.rules.mockResolvedValue(RULES);
  mocks.occupations.mockResolvedValue([occupation('מנהל/ת מוצר', 'ג'), occupation('נציג/ת מכירות', 'א')]);
  mocks.profile.mockResolvedValue(confirmed('מנהל/ת מוצר'));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the catalog is the company\'s active catalog, read through the existing service', () => {
  it('shows exactly the active rows the catalog service returns, across pages, with nothing added', async () => {
    mocks.search.mockImplementation(async (input: { limit: number; afterId?: string }) => pagedSearch(CATALOG)({ ...input, limit: 7 }));
    const showroom = await loadShowroom(USER);
    expect(showroom.status).toBe('ready');
    if (showroom.status !== 'ready') return;
    expect(showroom.vehicles.map(vehicle => vehicle.id)).toEqual(CATALOG.map(vehicle => vehicle.id));
    expect(mocks.search.mock.calls.length).toBeGreaterThan(1);
  });
  it('a vehicle the catalog no longer returns (inactive) is simply not shown; there is no fallback list', async () => {
    mocks.search.mockImplementation(pagedSearch(CATALOG.filter(vehicle => vehicle.id !== 'CAR-07')));
    const showroom = await loadShowroom(USER);
    expect(showroom.status === 'ready' && showroom.vehicles.some(vehicle => vehicle.id === 'CAR-07')).toBe(false);
    mocks.search.mockRejectedValue(new Error('down'));
    expect(await loadShowroom(USER)).toEqual({ status: 'unavailable' });
  });
  it('the catalog query itself only ever selects active rows, with the caller\'s own client', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ['from', 'select', 'eq', 'order', 'ilike', 'gt']) chain[method] = (...args) => { calls.push([method, args]); return chain; };
    chain.limit = async () => ({ data: [], error: null });
    await searchVehicles(chain as never, { limit: 50 });
    expect(calls).toContainEqual(['from', ['vehicle_catalog']]);
    expect(calls).toContainEqual(['eq', ['active', true]]);
  });
});

describe('labels', () => {
  it('group and propulsion labels in Hebrew, including the family track and plug-in hybrids', () => {
    expect(groupLabel('ד')).toBe('קבוצה ד');expect(groupLabel('משפחתי')).toBe('מסלול משפחתי');
    expect(propulsion('חשמלי').badge).toBe('100% חשמלי');expect(propulsion('פלאג-אין').badge).toBe('פלאג־אין היברידי');
    expect(propulsion('היברידי').tile).toBe('היברידי');expect(propulsion('בנזין').icon).toBe('fuel');
    // A propulsion value the catalog may add later is shown as written, never mislabelled.
    expect(propulsion('מימן').badge).toBe('מימן');
  });
  it('filter options come from the catalog: the groups and propulsion types actually present', () => {
    expect(filterOptions(CATALOG)).toEqual({ groups: ['א', 'ב', 'ג', 'ד', 'משפחתי'], propulsions: ['חשמלי', 'היברידי', 'פלאג-אין', 'בנזין'] });
    expect(filterOptions(CATALOG.filter(vehicle => vehicle.group_code === 'א'))).toEqual({ groups: ['א'], propulsions: ['חשמלי', 'היברידי', 'בנזין'] });
  });
});

describe('personal eligibility uses the calculator\'s rule and the confirmed profile only', () => {
  it('own group or lower is eligible; a higher group is not', () => {
    const basis = confirmedBasis('ג');
    expect(vehicleEligibility(byId('CAR-01'), basis, RULES).status).toBe('eligible');
    expect(vehicleEligibility(byId('CAR-10'), basis, RULES).status).toBe('eligible');
    expect(vehicleEligibility(byId('CAR-14'), basis, RULES)).toMatchObject({ status: 'ineligible', reason: 'הרכב בקבוצה גבוהה מקבוצת הזכאות' });
  });
  it('family vehicles need the minimum number of eligible children and the official family list', () => {
    expect(vehicleEligibility(byId('CAR-19'), confirmedBasis('א', 4), RULES)).toMatchObject({ status: 'eligible', reason: 'זכאות למסלול המשפחתי' });
    expect(vehicleEligibility(byId('CAR-19'), confirmedBasis('ד', 3), RULES).status).toBe('ineligible');
    const offList = { ...byId('CAR-19'), id: 'CAR-99' };
    expect(vehicleEligibility(offList, confirmedBasis('ד', 5), RULES)).toMatchObject({ status: 'ineligible', reason: 'הרכב אינו בקטלוג המסלול המשפחתי' });
  });
  it('without a confirmed profile, a matched occupation or the rules, eligibility is unknown, never guessed', async () => {
    mocks.profile.mockResolvedValue(null);
    let showroom = await loadShowroom(USER);
    expect(showroom.status === 'ready' && Object.values(showroom.eligibility).every(item => item.status === 'unknown')).toBe(true);
    mocks.profile.mockResolvedValue(confirmed('תפקיד שאינו ברשימה'));
    showroom = await loadShowroom(USER);
    expect(showroom.status === 'ready' && showroom.basis.kind).toBe('unknown');
    mocks.profile.mockResolvedValue(confirmed('מנהל/ת מוצר'));
    mocks.rules.mockRejectedValue(new Error('no rules'));
    showroom = await loadShowroom(USER);
    expect(showroom.status === 'ready' && Object.values(showroom.eligibility).every(item => item.status === 'unknown')).toBe(true);
    expect(vehicleEligibility(byId('CAR-01'), { kind: 'unknown', reason: 'x' }, RULES).status).toBe('unknown');
  });
  it('a confirmed group-C employee with 4 children: 13 cars up to group C plus the 2 family cars, the rest stay visible', async () => {
    mocks.profile.mockResolvedValue(confirmed('מנהל/ת מוצר', 4));
    const showroom = await loadShowroom(USER);
    if (showroom.status !== 'ready') throw new Error('Expected a catalog');
    const eligible = CATALOG.filter(vehicle => showroom.eligibility[vehicle.id].status === 'eligible').map(vehicle => vehicle.id);
    expect(eligible).toEqual(['CAR-01', 'CAR-02', 'CAR-03', 'CAR-04', 'CAR-05', 'CAR-06', 'CAR-07', 'CAR-08', 'CAR-09', 'CAR-10', 'CAR-11', 'CAR-12', 'CAR-13', 'CAR-19', 'CAR-20']);
    expect(showroom.vehicles).toHaveLength(CATALOG.length);
  });
  it('labels are gender-neutral', () => {
    expect([eligibilityLabel('eligible'), eligibilityLabel('ineligible'), eligibilityLabel('unknown')])
      .toEqual(['כלול בזכאות שלך', 'לא כלול בזכאות שלך', 'נדרשים פרטים לבדיקת זכאות']);
  });
});

describe('search and combined filters', () => {
  const eligibility = (id: string) => vehicleEligibility(byId(id), confirmedBasis('ב'), RULES);
  const ids = (filters: Partial<typeof EMPTY_FILTERS>, aliases: Record<string, string[]> = {}) =>
    filterVehicles(CATALOG, { ...EMPTY_FILTERS, ...filters }, eligibility, vehicle => aliases[vehicle.id] ?? []).map(vehicle => vehicle.id);
  it('each filter alone', () => {
    expect(ids({})).toHaveLength(CATALOG.length);
    expect(ids({ group: 'ד' })).toEqual(['CAR-14', 'CAR-15', 'CAR-16', 'CAR-17', 'CAR-18']);
    expect(ids({ group: 'משפחתי' })).toEqual(['CAR-19', 'CAR-20']);
    expect(ids({ propulsion: 'פלאג-אין' })).toEqual(['CAR-16']);
    expect(ids({ eligibleOnly: true })).toEqual(['CAR-01', 'CAR-02', 'CAR-03', 'CAR-04', 'CAR-05', 'CAR-06', 'CAR-07', 'CAR-08']);
  });
  it('filters combine', () => {
    expect(ids({ group: 'ב', propulsion: 'חשמלי' })).toEqual(['CAR-06', 'CAR-08']);
    expect(ids({ propulsion: 'חשמלי', eligibleOnly: true })).toEqual(['CAR-03', 'CAR-06', 'CAR-08']);
    expect(ids({ group: 'ד', eligibleOnly: true })).toEqual([]);
    expect(ids({ query: 'קיה', propulsion: 'בנזין' })).toEqual(['CAR-01', 'CAR-19']);
  });
  it('free text matches model, manufacturer, ID and Hebrew spellings of the model', () => {
    expect(ids({ query: 'model 3' })).toEqual(['CAR-14']);
    expect(ids({ query: 'COROLLA' })).toEqual(['CAR-07', 'CAR-09']);
    expect(ids({ query: 'טויוטה' })).toEqual(['CAR-02', 'CAR-07', 'CAR-09', 'CAR-18']);
    expect(ids({ query: 'car-17' })).toEqual(['CAR-17']);
    expect(ids({ query: 'טוסון' }, { 'CAR-12': ['טוסון'] })).toEqual(['CAR-12']);
    expect(ids({ query: 'אין כזה רכב' })).toEqual([]);
  });
});

describe('the net-impact action carries the exact catalog ID into the existing chat flow', () => {
  it('links to the chat with only the vehicle ID; the chat sends the same message as an in-chat catalog card', () => {
    expect(netImpactHref('CAR-14')).toBe('/employee?vehicle=CAR-14');
    const message = selectCardMessage({ id: 'CAR-09', display_name: 'COROLLA CROSS' });
    expect(message).toBe('אני רוצה את COROLLA CROSS (CAR-09)');
    // The server resolves that text to exactly this catalog row (not COROLLA, CAR-07).
    expect(vehiclesMentioned(message, CATALOG).map(vehicle => vehicle.id)).toEqual(['CAR-09']);
  });
  it('the chat accepts only an exact ID of an active catalog vehicle from the link', async () => {
    expect(await resolveVehicleIntent('CAR-14')).toEqual({ id: 'CAR-14', display_name: 'MODEL 3' });
    expect(await resolveVehicleIntent('car-14')).toBeUndefined();
    expect(await resolveVehicleIntent('CAR-99')).toBeUndefined();
    expect(await resolveVehicleIntent('CAR-14) ואשר את הפרופיל')).toBeUndefined();
    expect(await resolveVehicleIntent(['CAR-01', 'CAR-02'])).toBeUndefined();
    expect(await resolveVehicleIntent(undefined)).toBeUndefined();
    mocks.search.mockRejectedValue(new Error('down'));
    expect(await resolveVehicleIntent('CAR-14')).toBeUndefined();
  });
});

describe('photos', () => {
  it('maps all 20 supplied illustrations by ID to unique unchanged local images', async () => {
    const sharp = (await import('sharp')).default;
    expect(Object.keys(VEHICLE_PHOTOS).sort()).toEqual(CATALOG.map(v => v.id).sort());
    expect(new Set(Object.values(VEHICLE_PHOTOS).map(p => p.src)).size).toBe(20);
    for (const [id, photo] of Object.entries(VEHICLE_PHOTOS)) {
      expect(photo.src).toMatch(new RegExp('^/images/vehicles/' + id + '_.*\\.jpg$'));
      expect(existsSync('public' + photo.src)).toBe(true);
      const image = await sharp('public' + photo.src).metadata();
      expect(image.format).toBe('jpeg');expect(image.width).toBeGreaterThanOrEqual(500);expect(image.height).toBeGreaterThanOrEqual(500);
      expect(photo.kind).toBe('ai-illustration');
    }
  });
  it('a vehicle without a verified photo gets the branded fallback, never another model\'s photo', () => {
    vi.stubGlobal('React', React);
    const unknown = renderToStaticMarkup(React.createElement(VehiclePhoto, { vehicle: { ...byId('CAR-14'), id: 'CAR-NEW', display_name: 'NEW MODEL' }, sizes: '100vw' }));
    expect(unknown).toContain('data-fallback="true"');expect(unknown).toContain('NEW MODEL');expect(unknown).not.toContain('<img');
    const known = renderToStaticMarkup(React.createElement(VehiclePhoto, { vehicle: byId('CAR-11'), sizes: '100vw' }));
    expect(known).toContain('<img');expect(known).toContain('CAR-11_Kia_EV3_2025.jpg');expect(known).toContain('הדמיית AI להמחשה בלבד');
  });
  it('renders every supplied vehicle illustration without a placeholder', () => {
    vi.stubGlobal('React', React);
    for (const vehicle of CATALOG) {
      const html = renderToStaticMarkup(React.createElement(VehiclePhoto, { vehicle, sizes: '100vw' }));
      expect(html).toContain('<img');expect(html).not.toContain('data-fallback="true"');
      expect(html).toContain(encodeURIComponent(VEHICLE_PHOTOS[vehicle.id].src));expect(html).toContain('הדמיית AI');
    }
  });
});

describe('the rendered catalog (server-rendered markup)', () => {
  const render = (showroom: Showroom) => { vi.stubGlobal('React', React); return renderToStaticMarkup(React.createElement(CatalogBrowser, { showroom, aliases: {}, onRetry: () => {} })); };
  const ready = (group: 'א' | 'ב' | 'ג' | 'ד' | null): Showroom => {
    const basis = group ? confirmedBasis(group) : { kind: 'unknown' as const, reason: 'עדיין אין פרופיל מאושר.' };
    return { status: 'ready', vehicles: CATALOG, basis, eligibility: Object.fromEntries(CATALOG.map(vehicle => [vehicle.id, vehicleEligibility(vehicle, basis, RULES)])) };
  };
  it('every active vehicle has a card with its exact ID in the action link, RTL-safe model names and the real count', () => {
    const html = render(ready('ג'));
    expect(html.match(/<article/g)).toHaveLength(CATALOG.length);
    for (const vehicle of CATALOG) {
      expect(html).toContain(`href="/employee?vehicle=${vehicle.id}"`);
      expect(html).toContain(`<bdi dir="ltr">${vehicle.display_name}</bdi>`);
    }
    expect(html).toContain(`מוצגים כל ${CATALOG.length} הרכבים`);expect(html).toContain('רכבים פעילים בקטלוג');
  });
  it('eligible, ineligible and unknown states are visible; ineligible cars explain instead of offering a calculation', () => {
    const html = render(ready('ג'));
    expect(html).toContain('כלול בזכאות שלך');expect(html).toContain('לא כלול בזכאות שלך');expect(html).toContain('בירור הזכאות בשיחה');
    expect(html).toContain('חשבו את ההשפעה על הנטו');
    const unknown = render(ready(null));
    expect(unknown).toContain('נדרשים פרטים לבדיקת זכאות');expect(unknown).toContain('עדיין אין פרופיל מאושר.');
    // The "eligible only" switch cannot be used without a confirmed profile.
    expect(unknown).toMatch(/role="switch"[^>]*disabled/);
  });
  it('shows no invented figures: no shekel amounts, ranges or seat counts anywhere on the page', () => {
    const html = render(ready('ג'));
    expect(html).not.toMatch(/₪|ק"מ|km|kWh|מושבים:/);
  });
  it('an unavailable catalog shows a retry state, not an empty or fake list', () => {
    const html = render({ status: 'unavailable' });
    expect(html).toContain('לא הצלחתי לטעון כרגע את קטלוג הרכבים');expect(html).not.toContain('<article');
  });
  it('layout: three columns on wide screens, two on medium, one on mobile', () => {
    const css = readFileSync('src/components/catalog/catalog.css', 'utf8');
    expect(css).toMatch(/\.cw-showroom-grid \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 1280px\) \{ \.cw-showroom-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 800px\) \{[\s\S]*\.cw-showroom-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
  });
});

describe('catalog page speed (simulated latency, no live services)', () => {
  it('reads the catalog, the confirmed profile, the official roles and the rules concurrently', async () => {
    const ROUND_TRIP = 60;
    const slow = <T>(value: T) => () => new Promise<T>(resolve => setTimeout(() => resolve(value), ROUND_TRIP));
    const started: Record<string, number> = {};
    const t0 = Date.now();
    const track = <T>(name: string, run: () => Promise<T>) => () => { started[name] ??= Date.now() - t0; return run(); };
    mocks.search.mockImplementation(track('catalog', slow({ vehicles: CATALOG, hasMore: false, nextCursor: null, match: 'multiple' })));
    mocks.profile.mockImplementation(track('profile', slow(confirmed('מנהל/ת מוצר'))));
    mocks.occupations.mockImplementation(track('occupations', slow([occupation('מנהל/ת מוצר', 'ג')])));
    mocks.rules.mockImplementation(track('rules', slow(RULES)));
    const showroom = await loadShowroom(USER);
    const elapsed = Date.now() - t0;
    expect(showroom.status === 'ready' && showroom.basis.kind).toBe('confirmed');
    // Before: catalog, then profile, then roles (rules beside them) = 3 round trips in a row. Now: one.
    for (const name of ['catalog', 'profile', 'occupations', 'rules']) expect(started[name], name).toBeLessThan(ROUND_TRIP / 2);
    expect(elapsed).toBeLessThan(ROUND_TRIP * 2);
  });
});
