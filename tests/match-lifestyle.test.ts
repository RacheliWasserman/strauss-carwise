import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { cars, employees } from '../src/lib/data';
import rulesData from '../data/rules.json';
import occupationsData from '../data/occupations.json';
import { loadMatchContext, type MatchDependencies } from '../src/lib/match/match-service';
import { matchPreferencesSchema, rankVehicles, type MatchCandidate, type MatchPreferences } from '../src/lib/match/match-engine';
import { vehicleProfileFor, vehicleSpecsDataset } from '../src/lib/match/vehicle-profiles';
import type { CalculationRules } from '../src/lib/rules-repository';
import type { EmployeeDataVersionRow } from '../src/lib/employee-data-repository';
import type { Group } from '../src/lib/types';

const rules = rulesData as unknown as CalculationRules;
const occupations = occupationsData.map(row => ({ title: row['עיסוק'], group_code: row['קבוצת זכאות'] as Group, car_mandatory: row['רכב חובה'] === 'כן',
  waiver_allowed: row['מותר לוותר'] === 'כן', waiver_maintenance_amount: row['אחזקת רכב בוויתור (₪)'], key: createHash('sha256').update(row['עיסוק']).digest('hex') }));
const catalog = cars.map(car => ({ id: car['מזהה'], display_name: car['דגם (כינוי מסחרי)'], manufacturer_name: car['תוצר'], group_code: car['קבוצה'], drive_type: car['הנעה'] }));
const idOf = (name: string) => cars.find(car => car['דגם (כינוי מסחרי)'] === name)!['מזהה'];
async function ready(fixtureId: string) {
  const userId = randomUUID();
  const person = employees.find(item => item['מזהה'] === fixtureId)!;
  const profile: EmployeeDataVersionRow = { id: randomUUID(), user_id: userId, version: 1, status: 'confirmed', schema_version: 'v1', display_name: 'בדיקה',
    occupation_title: person['עיסוק'], base_salary: person['שכר בסיס'], commissions: person['עמלות'], bonus: person['בונוס'],
    employee_pension_percent: person['פנסיה עובד %'], employee_study_fund_percent: person['קרן השתלמות עובד %'], tax_credit_points: person['נקודות זיכוי'],
    eligible_children_count: person['ילדים עד 23'], current_vehicle_id: cars.find(car => car['דגם (כינוי מסחרי)'] === person['רכב היום'])?.['מזהה'] ?? null,
    current_participation: person['השתתפות היום'], created_at: '', confirmed_at: '' };
  const deps: MatchDependencies = { confirmed: async () => profile, occupations: async () => occupations, rules: async () => structuredClone(rules),
    catalog: async () => catalog, vehicles: async ids => new Map(ids.map(id => { const car = cars.find(item => item['מזהה'] === id); return [id, car ? { car, taxYear: 2026 } : null]; })) };
  const context = await loadMatchContext(userId, deps);
  if (context.status !== 'ready') throw new Error(context.status);
  return context;
}
const prefs = (value: MatchPreferences) => matchPreferencesSchema.parse(value);

describe('CarWise Match 2.0: supplemental vehicle dataset', () => {
  it('validates strictly and joins all 20 records to the catalog by exact ID, without conflicting identity data', () => {
    const toCatalog: Record<string, string> = { gasoline: 'בנזין', hybrid: 'היברידי', electric: 'חשמלי' };
    expect(vehicleSpecsDataset.vehicles.map(vehicle => vehicle.vehicleId)).toEqual(cars.map(car => car['מזהה']));
    for (const vehicle of vehicleSpecsDataset.vehicles) {
      const car = cars.find(item => item['מזהה'] === vehicle.vehicleId)!;
      expect(vehicle.registrationYear).toBe(car['שנת רישום']);
      if (vehicle.catalogPowertrain.value !== null) expect(toCatalog[vehicle.catalogPowertrain.value]).toBe(car['הנעה']);
      expect(vehicle.exactTrimVerified).toBe(false);
      expect(vehicleProfileFor(vehicle.vehicleId, car['שנת רישום'])).toBeDefined();
    }
    // CAR-16's conflict is kept as unknown in the file, never resolved here.
    expect(vehicleSpecsDataset.vehicles.find(vehicle => vehicle.vehicleId === 'CAR-16')!.catalogPowertrain.value).toBeNull();
  });

  it('turns unknown, null and contradictory values into "no data" and never invents a value', () => {
    expect(vehicleProfileFor('CAR-13')!.bodyType).toBeUndefined(); // "unknown" written as a value
    expect(vehicleProfileFor('CAR-19')!.seats).toBeUndefined();
    expect(vehicleProfileFor('CAR-20')!.trunkLiters).toBeUndefined();
    expect(vehicleProfileFor('CAR-01')!.rangeKm).toBeUndefined();
    expect(vehicleProfileFor('CAR-03')!.rangeKm).toEqual({ min: 340, max: 427 });
    expect(vehicleProfileFor('CAR-12')).toMatchObject({ bodyType: 'suv', seats: 5, trunkLiters: 620, sizeClass: 'family' });
    // A registration-year conflict means it may describe another vehicle: no profile at all.
    expect(vehicleProfileFor('CAR-12', 2030)).toBeUndefined();
    expect(vehicleProfileFor('CAR-99')).toBeUndefined();
  });

  it('never overwrites catalog identity, group, powertrain or money with supplemental data', async () => {
    const context = await ready('E-006');
    for (const candidate of context.candidates) {
      const car = cars.find(item => item['מזהה'] === candidate.id)!;
      expect([candidate.display_name, candidate.group_code, candidate.drive_type, candidate.registration_year])
        .toEqual([car['דגם (כינוי מסחרי)'], car['קבוצה'], car['הנעה'], car['שנת רישום']]);
    }
  });
});

describe('CarWise Match 2.0: lifestyle matching', () => {
  it('a mandatory 7-seat requirement excludes vehicles the data contradicts and never claims it is satisfied', async () => {
    const regular = await ready('E-001');
    const none = rankVehicles(regular.candidates, prefs({ powertrain: 'any', needs: ['seats7'], needsStrength: 'hard' }));
    expect(none.recommendations).toEqual([]);
    expect(none.empty).toMatch(/דרישות החובה \(7 מקומות ומעלה\)/);
    const family = await ready('E-002');
    const seven = rankVehicles(family.candidates, prefs({ powertrain: 'any', needs: ['seats7'], needsStrength: 'hard' }));
    expect(seven.recommendations.map(item => item.vehicle.id).sort()).toEqual([idOf('CARNIVAL'), idOf('SANTA FE')].sort());
    for (const item of seven.recommendations) {
      expect(item.missing.join(' ')).toMatch(/לא ידוע אם הרכב עומד בדרישת החובה "7 מקומות ומעלה"/);
      expect(item.reasons.join(' ')).not.toMatch(/מקומות ישיבה — מספיק/);
    }
  });

  it('a seat preference (not mandatory) only explains, it never excludes', async () => {
    const context = await ready('E-001');
    const outcome = rankVehicles(context.candidates, prefs({ powertrain: 'any', seats: '7' }));
    expect(outcome.recommendations).toHaveLength(3);
    expect(outcome.excluded.requirement).toBe(0);
    for (const item of outcome.recommendations) expect(item.tradeoffs.join(' ')).toMatch(/פחות מ־7 שציינת/);
  });

  it('a mandatory large trunk keeps only data-consistent vehicles first, then vehicles without data, flagged', async () => {
    const context = await ready('E-006');
    const outcome = rankVehicles(context.candidates, prefs({ powertrain: 'any', needs: ['large_trunk'], needsStrength: 'hard' }));
    expect(outcome.excluded.requirement).toBeGreaterThan(0);
    for (const item of outcome.recommendations) {
      const trunk = item.profile.trunkLiters;
      expect(trunk === undefined || trunk >= 450).toBe(true);
      expect(item.missing.join(' ')).toMatch(trunk === undefined ? /לא ידוע אם הרכב עומד/ : /לא אומתה לגרסה המדויקת/);
    }
    const known = outcome.recommendations.map(item => item.profile.trunkLiters !== undefined);
    expect(known).toEqual([...known].sort((a, b) => Number(b) - Number(a)));
  });

  it('charging access shapes electric suitability and explains the tradeoff instead of silently excluding EVs', async () => {
    const context = await ready('E-001');
    const noCharging = rankVehicles(context.candidates, prefs({ powertrain: 'any', charging: 'none', finance: 'fit_first' }));
    expect(noCharging.recommendations.every(item => item.vehicle.drive_type !== 'חשמלי')).toBe(true);
    expect(noCharging.recommendations.some(item => item.reasons.join(' ').includes('לא נדרשת טעינה'))).toBe(true);
    const ev = rankVehicles(context.candidates.filter(candidate => candidate.drive_type === 'חשמלי'), prefs({ powertrain: 'any', charging: 'none' }));
    expect(ev.recommendations.length).toBeGreaterThan(0);
    for (const item of ev.recommendations) expect(item.tradeoffs.join(' ')).toMatch(/אין לך אפשרות טעינה קבועה/);
    const home = rankVehicles(context.candidates, prefs({ powertrain: 'חשמלי', strength: 'soft', charging: 'home' }));
    expect(home.recommendations[0].vehicle.drive_type).toBe('חשמלי');
    expect(home.recommendations[0].reasons.join(' ')).toMatch(/טעינה בבית/);
  });

  it('high monthly mileage with an EV states that the exact range is unknown, without scoring the indicative range', async () => {
    const context = await ready('E-001');
    const evs = context.candidates.filter(candidate => candidate.drive_type === 'חשמלי');
    const high = rankVehicles(evs, prefs({ powertrain: 'any', distance: 'high' }));
    const low = rankVehicles(evs, prefs({ powertrain: 'any', distance: 'low' }));
    expect(high.recommendations[0].tradeoffs.join(' ')).toMatch(/הטווח המדויק של הגרסה הזו אינו ידוע/);
    // The range note is information, not a criterion: evidence equals the same long-trip criterion without it.
    expect(high.recommendations.map(item => item.evidence)).toEqual(rankVehicles(evs, prefs({ powertrain: 'any', driving: 'long' })).recommendations.map(item => item.evidence));
    expect(low.recommendations.map(item => item.vehicle.id)).toEqual(rankVehicles(evs, prefs({ powertrain: 'any' })).recommendations.map(item => item.vehicle.id));
  });

  it('city driving favours compact models and says why, based on general model characteristics', async () => {
    const context = await ready('E-006');
    const outcome = rankVehicles(context.candidates, prefs({ powertrain: 'any', driving: 'city', priorities: ['city'], finance: 'fit_first' }));
    for (const item of outcome.recommendations) expect(['small', 'compact']).toContain(item.profile.sizeClass);
    expect(outcome.recommendations[0].reasons.join(' ')).toMatch(/נוח לתמרון ולחניה בעיר \(לפי מאפייני הדגם הכלליים\)/);
  });

  it('a large family with a trunk priority gets roomy models with known trunk data before models without data', async () => {
    const context = await ready('E-006');
    const outcome = rankVehicles(context.candidates, prefs({ powertrain: 'any', travelers: 'large_family',
      priorities: ['large_trunk', 'family_space'], finance: 'fit_first', family: 'exclude' }));
    expect(outcome.recommendations.every(item => (item.profile.trunkLiters ?? 0) >= 450)).toBe(true);
  });

  it('unknown data is neither a plus nor a minus: scores normalise over known criteria and evidence is reported', () => {
    const base = { manufacturer_name: 'יצרן', group_code: 'א' as const, drive_type: 'בנזין', eligibilityReason: 'בקבוצה', family: false, current: false,
      financial: { status: 'estimate' as const, delta: 100, electricBonus: 0, familyShare: 0 } };
    const withData: MatchCandidate = { ...base, id: 'CAR-02', display_name: 'B', profile: { sizeClass: 'family', trunkLiters: 600 } };
    const without: MatchCandidate = { ...base, id: 'CAR-01', display_name: 'A', profile: {} };
    const outcome = rankVehicles([without, withData], prefs({ powertrain: 'any', priorities: ['large_trunk'] }));
    expect(outcome.recommendations.map(item => item.vehicle.id)).toEqual(['CAR-02', 'CAR-01']);
    expect(outcome.recommendations[1].evidence).toEqual({ known: 1, total: 2 });
    expect(outcome.recommendations[1].missing).toContain('אין נתון על נפח תא המטען.');
    expect(outcome.recommendations[0].fitLabel).toBe('high');
  });

  it('shows a qualitative fit label only with enough evidence, and never a percentage', async () => {
    const make = (id: string): MatchCandidate => ({ id, display_name: id, manufacturer_name: 'יצרן', group_code: 'א', drive_type: 'בנזין',
      eligibilityReason: 'בקבוצה', family: false, current: false, financial: { status: 'unavailable', reason: 'חסר.' }, profile: {} });
    expect(rankVehicles([make('CAR-01')], prefs({ powertrain: 'any', priorities: ['large_trunk', 'city'], seats: '5' })).recommendations[0].fitLabel).toBeNull();
    const context = await ready('E-001');
    expect(JSON.stringify(rankVehicles(context.candidates, prefs({ powertrain: 'any', travelers: 'couple', driving: 'mixed' })))).not.toMatch(/%/);
  });

  it('says plainly which preferences the data cannot evaluate, and they do not change the ranking', async () => {
    const context = await ready('E-001');
    const ids = (value: MatchPreferences) => rankVehicles(context.candidates, value).recommendations.map(item => item.vehicle.id);
    const withUnsupported = rankVehicles(context.candidates, prefs({ powertrain: 'any', priorities: ['technology', 'energy'] }));
    expect(withUnsupported.unsupported.join(' ')).toMatch(/טכנולוגיה ואבזור/);
    expect(withUnsupported.unsupported.join(' ')).toMatch(/חיסכון בדלק או בחשמל/);
    expect(ids(prefs({ powertrain: 'any', priorities: ['technology', 'energy'] }))).toEqual(ids(prefs({ powertrain: 'any' })));
  });

  it('labels a card "value" only when its estimate is higher than the top recommendation, "top" only with a good fit', async () => {
    const context = await ready('E-001');
    for (const preferences of [prefs({ powertrain: 'any', driving: 'city', finance: 'fit_first' }), prefs({ powertrain: 'any', travelers: 'large_family' })]) {
      const recs = rankVehicles(context.candidates, preferences).recommendations;
      const first = recs[0].financial.status === 'estimate' ? recs[0].financial.delta : -Infinity;
      for (const item of recs.filter(rec => rec.label === 'value')) expect(item.financial.status === 'estimate' && item.financial.delta > first).toBe(true);
      if (recs[0].label === 'top') expect(['high', 'good']).toContain(recs[0].fitLabel);
    }
  });

  it('is deterministic: the same answers give the same report, whatever the input order', async () => {
    const context = await ready('E-006');
    const preferences = prefs({ powertrain: 'חשמלי', strength: 'soft', travelers: 'small_family', priorities: ['cost', 'family_space', 'large_trunk'],
      driving: 'mixed', distance: 'high', charging: 'work', needs: ['high_body'], needsStrength: 'soft', finance: 'balanced' });
    const first = rankVehicles(context.candidates, preferences);
    expect(rankVehicles([...context.candidates].reverse(), preferences)).toEqual(first);
    expect(rankVehicles(context.candidates, preferences)).toEqual(first);
  });

  it('keeps CAR-16 conservative in lifestyle matching: never a powertrain match, charging suitability unknown', async () => {
    const context = await ready('E-006');
    const only = context.candidates.filter(candidate => candidate.id === 'CAR-16');
    const item = rankVehicles(only, prefs({ powertrain: 'פלאג-אין', strength: 'soft', charging: 'home' })).recommendations[0];
    expect(item.fit).toBe('unverified');
    expect(item.reasons.join(' ')).not.toMatch(/תואם להעדפה|טעינה בבית/);
    expect(item.missing.join(' ')).toMatch(/סיווג ההנעה בבדיקה/);
  });

  it('rejects malformed or forged lifestyle answers', () => {
    for (const invalid of [{ powertrain: 'any', priorities: ['cost', 'city', 'technology', 'energy'] }, { powertrain: 'any', priorities: ['cost', 'cost'] },
      { powertrain: 'any', needs: ['jet_pack'] }, { powertrain: 'any', needsStrength: 'hard' }, { powertrain: 'any', seats: 9 },
      { powertrain: 'any', charging: 'solar' }, { powertrain: 'any', finance: 'free' }, { powertrain: 'any', travelers: 'everyone' }]) {
      expect(matchPreferencesSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
