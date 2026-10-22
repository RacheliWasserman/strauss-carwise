import * as React from 'react';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ profile: vi.fn(), identity: vi.fn(), save: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-authenticated-user', () => ({ getAuthenticatedProfile: mocks.profile }));
vi.mock('@/components/logout-button', () => ({ LogoutButton: () => null }));

import {
  applyPayslipToForm, changedProfileFields, initialProfileForm, NO_VEHICLE, profileSaveSchema, splitDisplayName, validateProfileForm,
  type ProfileFormValues, type ProfileSave
} from '../src/lib/profile/profile-form';
import { loadOwnProfile, saveOwnProfile, type ProfileDependencies } from '../src/lib/profile/profile-service';
import type { EmployeeDataVersionRow } from '../src/lib/employee-data-repository';
import type { AdvisorOccupation } from '../src/lib/occupation-repository';
import { filterOccupations } from '../src/components/profile/occupation-picker';
import { cardClickOpensDetails } from '../src/components/catalog/catalog-browser';
import { ChatSidebar } from '../src/components/chat/chat-sidebar';
import { PAYSLIP_REVIEW_KIND, type PayslipReview } from '../src/lib/payslip/payslip-contract';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const KEY_SALES = 'a'.repeat(64), KEY_MANAGER = 'b'.repeat(64);
// Fictional test values only; no real salary data.
const occupations: AdvisorOccupation[] = [
  { key: KEY_SALES, title: 'נציג/ת מכירות שטח', group_code: 'ב', car_mandatory: true, waiver_allowed: false, waiver_maintenance_amount: 0 },
  { key: KEY_MANAGER, title: 'מנהל/ת אזור מכירות', group_code: 'ג', car_mandatory: true, waiver_allowed: false, waiver_maintenance_amount: 0 }
];
const vehicles = [{ id: 'CAR-01', display_name: 'TEST CAR', manufacturer_name: 'יצרן בדיקה', group_code: 'ב' as const, drive_type: 'חשמלי' }];
const row = (extra: Partial<EmployeeDataVersionRow> = {}): EmployeeDataVersionRow => ({
  id: '33333333-3333-4333-8333-333333333333', user_id: USER, version: 2, status: 'confirmed', schema_version: 'employee-data-v1',
  created_at: '2026-10-20T10:00:00.000Z', confirmed_at: '2026-10-20T10:00:01.000Z', display_name: 'בדיקה ישראלית', occupation_title: 'נציג/ת מכירות שטח',
  base_salary: 12000, commissions: 0, bonus: 500, employee_pension_percent: 6, employee_study_fund_percent: 2.5, tax_credit_points: 2.25,
  eligible_children_count: 1, current_vehicle_id: 'CAR-01', current_participation: 300, ...extra
});
function deps(confirmed: EmployeeDataVersionRow | null = row()) {
  const created: unknown[] = [];
  const use: ProfileDependencies & { created: unknown[] } = {
    created,
    confirmed: vi.fn(async () => confirmed),
    occupations: vi.fn(async () => occupations),
    vehicles: vi.fn(async () => vehicles),
    createVersion: vi.fn(async (_user, input) => { created.push(input); return row({ ...input, id: '44444444-4444-4444-8444-444444444444', status: 'draft', confirmed_at: null, version: 3 }); }),
    confirmVersion: vi.fn(async (_user, id) => row({ ...(created.at(-1) as object), id, version: 3 }))
  };
  return use;
}
const save = (extra: Partial<ProfileSave> = {}): ProfileSave => ({ basedOnVersionId: row().id, occupationKey: KEY_MANAGER, base_salary: 12000, commissions: 0,
  bonus: 500, employee_pension_percent: 6, employee_study_fund_percent: 2.5, tax_credit_points: 2.25, eligible_children_count: 1,
  current_vehicle_id: 'CAR-01', current_participation: 300, ...extra });
const ACCOUNT = { status: 'complete' as const, firstName: 'בדיקה', lastName: 'ישראלית' };
const lists = { occupationKeys: new Set([KEY_SALES, KEY_MANAGER]), vehicleIds: new Set(['CAR-01']) };
const filled = (extra: Partial<ProfileFormValues> = {}): ProfileFormValues => ({ firstName: 'בדיקה', lastName: 'ישראלית', occupationKey: KEY_SALES,
  base_salary: '12,000', commissions: '0', bonus: '500', employee_pension_percent: '6', employee_study_fund_percent: '2.5', tax_credit_points: '2.25',
  eligible_children_count: '1', current_vehicle_id: 'CAR-01', current_participation: '300', ...extra });

describe('profile form: one record, nothing invented', () => {
  it('opens with the saved profile, so an untouched field is saved again unchanged', () => {
    const snapshot = { ...row(), versionId: row().id, confirmedAt: row().confirmed_at, displayName: 'בדיקה ישראלית', occupationTitle: 'נציג/ת מכירות שטח', occupationKey: KEY_SALES };
    const form = initialProfileForm(snapshot as never, { firstName: 'בדיקה', lastName: 'ישראלית' });
    expect(form).toMatchObject({ occupationKey: KEY_SALES, base_salary: '12000', bonus: '500', current_vehicle_id: 'CAR-01', current_participation: '300' });
    expect(initialProfileForm(null, { firstName: '', lastName: '' })).toMatchObject({ base_salary: '', current_vehicle_id: '' });
    expect(initialProfileForm({ ...snapshot, current_vehicle_id: null } as never, { firstName: '', lastName: '' }).current_vehicle_id).toBe(NO_VEHICLE);
  });
  it('treats an empty field as an error, never as 0', () => {
    const result = validateProfileForm(filled({ bonus: '', commissions: ' ' }), { needsName: false, basedOnVersionId: null, ...lists });
    expect(result.errors?.bonus).toContain('שדה חובה');
    expect(result.errors?.commissions).toContain('שדה חובה');
    expect(result.payload).toBeUndefined();
  });
  it('accepts only a role from the official list, and requires a current-car choice', () => {
    expect(validateProfileForm(filled({ occupationKey: '' }), { needsName: false, basedOnVersionId: null, ...lists }).errors?.occupationKey).toBeTruthy();
    expect(validateProfileForm(filled({ occupationKey: 'c'.repeat(64) }), { needsName: false, basedOnVersionId: null, ...lists }).errors?.occupationKey).toContain('הרשמית');
    expect(validateProfileForm(filled({ current_vehicle_id: '' }), { needsName: false, basedOnVersionId: null, ...lists }).errors?.current_vehicle_id).toBeTruthy();
    expect(validateProfileForm(filled({ current_vehicle_id: 'CAR-99' }), { needsName: false, basedOnVersionId: null, ...lists }).errors?.current_vehicle_id).toContain('בקטלוג');
  });
  it('checks units and ranges like the chat does', () => {
    const errors = validateProfileForm(filled({ base_salary: '800', employee_pension_percent: '45', eligible_children_count: '1.5', tax_credit_points: 'abc' }),
      { needsName: false, basedOnVersionId: null, ...lists }).errors!;
    expect(errors.base_salary).toContain('שכר חודשי מלא');
    expect(errors.employee_pension_percent).toContain('גבוה');
    expect(errors.eligible_children_count).toContain('שלם');
    expect(errors.tax_credit_points).toContain('מספר');
  });
  it('without a company car the participation is 0 by definition', () => {
    const result = validateProfileForm(filled({ current_vehicle_id: NO_VEHICLE, current_participation: '' }), { needsName: false, basedOnVersionId: null, ...lists });
    expect(result.payload).toMatchObject({ current_vehicle_id: null, current_participation: 0, base_salary: 12000 });
    expect(profileSaveSchema.safeParse({ ...save(), current_vehicle_id: null, current_participation: 300 }).success).toBe(false);
  });
  it('asks for the name only when the account has none, and validates it', () => {
    expect(validateProfileForm(filled(), { needsName: false, basedOnVersionId: null, ...lists }).payload?.name).toBeUndefined();
    expect(validateProfileForm(filled({ firstName: '' }), { needsName: true, basedOnVersionId: null, ...lists }).errors?.firstName).toBeTruthy();
    expect(validateProfileForm(filled(), { needsName: true, basedOnVersionId: null, ...lists }).payload?.name).toEqual({ firstName: 'בדיקה', lastName: 'ישראלית' });
    expect(splitDisplayName('  בת  שבע כהן ')).toEqual({ firstName: 'בת', lastName: 'שבע כהן' });
  });
  it('reports which fields changed, comparing numbers by value', () => {
    expect(changedProfileFields(filled({ base_salary: '12000' }), filled())).toEqual([]);
    expect(changedProfileFields(filled({ bonus: '600', occupationKey: KEY_MANAGER }), filled())).toEqual(['occupationKey', 'bonus']);
  });
});

describe('payslip → profile form (nothing saved before the employee saves)', () => {
  const review = (values: PayslipReview['values']): PayslipReview => ({ kind: PAYSLIP_REVIEW_KIND, method: 'manual', values,
    extracted: { base_salary: null, commissions: null, bonus: null, employee_pension_percent: null, employee_study_fund_percent: null, tax_credit_points: null, current_participation: null } });
  it('applies only kept values; "unknown" and empty rows leave the field as it was', () => {
    const { form, applied } = applyPayslipToForm(filled(), review({ base_salary: 18500, bonus: 'unknown' }));
    expect(applied).toEqual(['base_salary']);
    expect(form.base_salary).toBe('18500');
    expect(form.bonus).toBe('500');
  });
  it('a participation amount means a company car: "no car" is cleared for the employee to choose', () => {
    const { form } = applyPayslipToForm(filled({ current_vehicle_id: NO_VEHICLE, current_participation: '0' }), review({ current_participation: 350 }));
    expect(form.current_vehicle_id).toBe('');
    expect(form.current_participation).toBe('350');
  });
});

describe('saving the profile (same versioned record as the chat approval)', () => {
  it('writes a new confirmed version with the official title and the account name', async () => {
    const use = deps();
    const outcome = await saveOwnProfile(USER, save({ base_salary: 13000 }), ACCOUNT, use);
    expect(outcome.status).toBe('saved');
    expect(use.createVersion).toHaveBeenCalledWith(USER, expect.objectContaining({ occupation_title: 'מנהל/ת אזור מכירות', display_name: 'בדיקה ישראלית', base_salary: 13000 }));
    expect(use.confirmVersion).toHaveBeenCalledWith(USER, '44444444-4444-4444-8444-444444444444');
    expect(outcome.status === 'saved' && outcome.snapshot).toMatchObject({ occupationKey: KEY_MANAGER, base_salary: 13000, version: 3 });
  });
  it('writes nothing when the values equal the approved profile', async () => {
    const use = deps();
    expect((await saveOwnProfile(USER, save({ occupationKey: KEY_SALES }), ACCOUNT, use)).status).toBe('unchanged');
    expect(use.createVersion).not.toHaveBeenCalled();
  });
  it('never overwrites a profile approved meanwhile (e.g. in the chat)', async () => {
    const use = deps(row({ id: '55555555-5555-4555-8555-555555555555', version: 4 }));
    const outcome = await saveOwnProfile(USER, save(), ACCOUNT, use);
    expect(outcome).toMatchObject({ status: 'stale', snapshot: { version: 4 } });
    expect(use.createVersion).not.toHaveBeenCalled();
  });
  it('rejects a role or a car that is not on the official lists', async () => {
    const use = deps();
    expect((await saveOwnProfile(USER, save({ occupationKey: 'c'.repeat(64) }), ACCOUNT, use)).status).toBe('invalid_occupation');
    expect((await saveOwnProfile(USER, save({ current_vehicle_id: 'CAR-99' }), ACCOUNT, use)).status).toBe('invalid_vehicle');
    expect(use.createVersion).not.toHaveBeenCalled();
  });
  it('uses the typed name only when the account has no stored name', async () => {
    const use = deps(null);
    expect((await saveOwnProfile(USER, save({ basedOnVersionId: null }), { status: 'unavailable' }, use)).status).toBe('name_required');
    expect((await saveOwnProfile(USER, save({ basedOnVersionId: null, name: { firstName: 'שם', lastName: 'בדיקה' } }), { status: 'unavailable' }, use)).status).toBe('saved');
    expect(use.createVersion).toHaveBeenCalledWith(USER, expect.objectContaining({ display_name: 'שם בדיקה' }));
    // An account name wins over anything typed.
    const withAccount = deps(null);
    await saveOwnProfile(USER, save({ basedOnVersionId: null, name: { firstName: 'אחר', lastName: 'לגמרי' } }), ACCOUNT, withAccount);
    expect(withAccount.createVersion).toHaveBeenCalledWith(USER, expect.objectContaining({ display_name: 'בדיקה ישראלית' }));
  });
  it('stores participation 0 without a car and does not need the catalog for it', async () => {
    const use = deps();
    await saveOwnProfile(USER, save({ current_vehicle_id: null, current_participation: 0 }), ACCOUNT, use);
    expect(use.vehicles).not.toHaveBeenCalled();
    expect(use.createVersion).toHaveBeenCalledWith(USER, expect.objectContaining({ current_vehicle_id: null, current_participation: 0 }));
  });
  it('fails closed on another user\'s row or on unavailable lists', async () => {
    expect((await saveOwnProfile(USER, save(), ACCOUNT, deps(row({ user_id: OTHER })))).status).toBe('failed');
    const use = deps(); use.occupations = vi.fn(async () => { throw new Error('down'); });
    expect((await saveOwnProfile(USER, save(), ACCOUNT, use)).status).toBe('unavailable');
  });
});

describe('loading the profile', () => {
  it('reads everything at once and resolves the saved title to its official key', async () => {
    const use = deps();
    const data = await loadOwnProfile(USER, use);
    expect(data.snapshot).toMatchObject({ occupationKey: KEY_SALES, base_salary: 12000, current_vehicle_id: 'CAR-01' });
    expect(data.occupations?.map(item => item.title)).toEqual(occupations.map(item => item.title));
    expect(data.occupations?.[0]).not.toHaveProperty('waiver_maintenance_amount');
    expect(data.vehicles).toEqual([{ id: 'CAR-01', display_name: 'TEST CAR', manufacturer_name: 'יצרן בדיקה' }]);
  });
  it('reports an unavailable list as null (never local data) and an unreadable profile as unavailable', async () => {
    const use = deps();
    use.occupations = vi.fn(async () => { throw new Error('down'); });
    use.confirmed = vi.fn(async () => { throw new Error('down'); });
    const data = await loadOwnProfile(USER, use);
    expect(data).toMatchObject({ occupations: null, snapshot: null, profileUnavailable: true });
  });
  it('shows an empty form when the account has no confirmed version (no demo row, no payslip values)', async () => {
    const data = await loadOwnProfile(USER, deps(null));
    expect(data).toMatchObject({ snapshot: null, profileUnavailable: false });
    const form = initialProfileForm(data.snapshot, { firstName: 'נועה', lastName: 'לוי' });
    for (const field of ['base_salary', 'commissions', 'bonus', 'employee_pension_percent', 'employee_study_fund_percent',
      'tax_credit_points', 'eligible_children_count', 'current_participation', 'occupationKey', 'current_vehicle_id'] as const) expect(form[field]).toBe('');
  });
  it('the profile source is the confirmed version only: the demo employees table and payslip code never feed or write it', () => {
    const service = readFileSync('src/lib/profile/profile-service.ts', 'utf8');
    expect(service).toContain('getLatestConfirmedEmployeeData');
    expect(service).not.toMatch(/employee-repository'|from\('employees'\)/);
    for (const file of ['src/lib/payslip/payslip-upload-request.ts', 'src/lib/payslip/payslip-service.ts', 'src/app/api/profile/payslip/route.ts'])
      expect(readFileSync(file, 'utf8')).not.toMatch(/employee-data-repository|advisor_employee_data_versions|createVersion|confirmVersion/);
  });
});

describe('POST /api/profile', () => {
  let POST: (request: Request) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    mocks.profile.mockReset(); mocks.identity.mockReset(); mocks.save.mockReset();
    vi.doMock('../src/lib/identity/identity-repository', () => ({ getOwnIdentity: mocks.identity }));
    vi.doMock('../src/lib/profile/profile-service', () => ({ saveOwnProfile: mocks.save }));
    mocks.profile.mockResolvedValue({ userId: USER, role: 'employee' });
    mocks.identity.mockResolvedValue(ACCOUNT);
    ({ POST } = await import('../src/app/api/profile/route'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { vi.doUnmock('../src/lib/identity/identity-repository'); vi.doUnmock('../src/lib/profile/profile-service'); });
  const call = (body: unknown, origin?: string) => POST(new Request('http://localhost/api/profile', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

  it('lets only the signed-in employee save, from this site', async () => {
    mocks.profile.mockResolvedValueOnce(null);
    expect((await call(save())).status).toBe(401);
    mocks.profile.mockResolvedValueOnce({ userId: USER, role: 'representative' });
    expect((await call(save())).status).toBe(403);
    expect((await call(save(), 'https://evil.example')).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects malformed or extra input before touching the database', async () => {
    expect((await call('{bad')).status).toBe(400);
    expect((await call({ ...save(), user_id: OTHER })).status).toBe(400);
    expect((await call({ ...save(), base_salary: -1 })).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('saves for the session user only and never logs values', async () => {
    mocks.save.mockResolvedValue({ status: 'saved', snapshot: { version: 3 } });
    const response = await call(save());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.save).toHaveBeenCalledWith(USER, expect.objectContaining({ base_salary: 12000 }), ACCOUNT);
    expect(JSON.stringify((console.info as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('12000');
  });
  it('answers a profile changed meanwhile with 409 and the current version', async () => {
    mocks.save.mockResolvedValue({ status: 'stale', snapshot: { version: 4 } });
    const response = await call(save());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale', snapshot: { version: 4 } });
  });
});

describe('POST /api/profile/payslip (same extraction as the chat)', () => {
  it('requires a signed-in employee and reads a digital payslip locally', async () => {
    process.env.SUPABASE_SECRET_KEY ||= 'test-only-secret';
    delete process.env.PAYSLIP_VISION_ENABLED;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('../src/app/api/profile/payslip/route');
    const upload = () => { const form = new FormData(); form.append('file', new Blob([readFileSync('tests/fixtures/payslips/payslip-a.pdf') as unknown as BlobPart]), 'a.pdf');
      return POST(new Request('http://localhost/api/profile/payslip', { method: 'POST', body: form })); };
    mocks.profile.mockResolvedValueOnce(null);
    expect((await upload()).status).toBe(401);
    mocks.profile.mockResolvedValueOnce({ userId: randomUUID(), role: 'representative' });
    expect((await upload()).status).toBe(403);
    mocks.profile.mockResolvedValueOnce({ userId: randomUUID(), role: 'employee' });
    const response = await upload();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('extracted');
    expect(body.method).toBe('pdf_text');
  });
});

describe('role search', () => {
  it('finds roles regardless of slashes and gendered endings', () => {
    expect(filterOccupations(occupations, 'נציגת').map(item => item.key)).toEqual([KEY_SALES]);
    expect(filterOccupations(occupations, 'מכירות').length).toBe(2);
    expect(filterOccupations(occupations, '  ')).toHaveLength(2);
    expect(filterOccupations(occupations, 'טייס')).toEqual([]);
  });
});

describe('catalog card and sidebar navigation', () => {
  it('a click on the card opens details, but not on its own controls or while selecting text', () => {
    class FakeElement { constructor(private control: boolean) {} closest(selector: string) { return this.control && selector.includes('button') ? {} : null; } }
    vi.stubGlobal('Element', FakeElement);
    const element = (control: boolean) => new FakeElement(control) as unknown as EventTarget;
    expect(cardClickOpensDetails(element(false))).toBe(true);
    expect(cardClickOpensDetails(element(true))).toBe(false);
    expect(cardClickOpensDetails(element(false), 'TEST CAR')).toBe(false);
    vi.unstubAllGlobals();
  });
  it('"הפרופיל שלי" sits directly above "שיחה חדשה" and is held back while a message is in progress', () => {
    vi.stubGlobal('React', React);
    const props = { conversations: [], titles: {}, activeId: null, open: false, loading: false, error: null, hasMore: false,
      onClose: () => {}, onSelect: () => {}, onLoadMore: () => {}, onRetry: () => {} };
    const html = renderToStaticMarkup(React.createElement(ChatSidebar, { ...props, locked: false }));
    const profileAt = html.indexOf('הפרופיל שלי'), newChatAt = html.indexOf('שיחה חדשה');
    expect(profileAt).toBeGreaterThan(-1);
    expect(profileAt).toBeLessThan(newChatAt);
    expect(html.slice(profileAt, newChatAt)).not.toContain('cw-history');
    expect(html).toContain('href="/profile"');
    expect(renderToStaticMarkup(React.createElement(ChatSidebar, { ...props, locked: true }))).toContain('aria-disabled="true"');
    expect(renderToStaticMarkup(React.createElement(ChatSidebar, { ...props, locked: false, section: 'profile' }))).toContain('aria-current="page"');
    vi.unstubAllGlobals();
  });
});

describe('first-load weight (performance)', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  it('the Supabase browser SDK and the sign-up validation load on use, not with the page', () => {
    for (const file of ['src/components/logout-button.tsx', 'src/components/auth-form.tsx']) {
      expect(read(file)).not.toMatch(/^import [^;]*supabase-browser/m);
      expect(read(file)).toContain("import('@/lib/supabase-browser')");
    }
    expect(read('src/components/auth-form.tsx')).not.toMatch(/^import [^;]*employee-identity/m);
  });
  it('the payslip dialog is loaded on demand in the chat and the profile', () => {
    for (const file of ['src/components/chat/employee-chat.tsx', 'src/components/profile/profile-app.tsx']) {
      expect(read(file)).not.toMatch(/^import \{ PayslipUpload \}/m);
      expect(read(file)).toMatch(/dynamic\(\(\) => import\('[./a-z-]*payslip-upload'\)/);
    }
  });
  it('Match no longer bundles the catalog page to get the conversation list', () => {
    expect(read('src/components/match/match-app.tsx')).not.toContain("from '../catalog/catalog-app'");
  });
  it('the middleware reads the role only for the root redirect', () => {
    const source = read('src/middleware.ts');
    expect(source.indexOf("if (pathname !== '/')")).toBeGreaterThan(-1);
    expect(source.indexOf("if (pathname !== '/')")).toBeLessThan(source.indexOf(".from('user_profiles')"));
  });
  it('the registration form is compact on desktop and keeps full-size fields on phones', () => {
    expect(read('src/components/auth-form.tsx')).toContain("isRegister ? 'auth-panel auth-panel-compact' : 'auth-panel'");
    expect(read('src/app/globals.css')).toMatch(/@media\(min-width:761px\)\{\s*\.auth-panel-compact\{/);
  });
});
