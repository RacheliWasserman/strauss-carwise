import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { cars, employees, references } from '../src/lib/data';
import rulesData from '../data/rules.json';
import occupationsData from '../data/occupations.json';
import { loadMatchContext, type MatchDependencies } from '../src/lib/match/match-service';
import { matchPreferencesSchema, nextQuestion, rankVehicles, type MatchCandidate, type MatchPreferences } from '../src/lib/match/match-engine';
import { calculateNet, displayShekels } from '../src/lib/calculator';
import type { CalculationRules } from '../src/lib/rules-repository';
import type { EmployeeDataVersionRow } from '../src/lib/employee-data-repository';
import type { Group } from '../src/lib/types';

const rules = rulesData as unknown as CalculationRules;
const occupations = occupationsData.map(row => ({ title: row['עיסוק'], group_code: row['קבוצת זכאות'] as Group, car_mandatory: row['רכב חובה'] === 'כן',
  waiver_allowed: row['מותר לוותר'] === 'כן', waiver_maintenance_amount: row['אחזקת רכב בוויתור (₪)'], key: createHash('sha256').update(row['עיסוק']).digest('hex') }));
const catalog = cars.map(car => ({ id: car['מזהה'], display_name: car['דגם (כינוי מסחרי)'], manufacturer_name: car['תוצר'],
  group_code: car['קבוצה'], drive_type: car['הנעה'] }));
const idOf = (name: string) => cars.find(car => car['דגם (כינוי מסחרי)'] === name)!['מזהה'];

/** A confirmed profile built from a challenge fixture employee (fictional data). */
function profileOf(fixtureId: string, userId: string, overrides: Partial<EmployeeDataVersionRow> = {}): EmployeeDataVersionRow {
  const person = employees.find(item => item['מזהה'] === fixtureId)!;
  const current = cars.find(car => car['דגם (כינוי מסחרי)'] === person['רכב היום'])?.['מזהה'] ?? null;
  return { id: randomUUID(), user_id: userId, version: 1, status: 'confirmed', schema_version: 'employee-data-v1', display_name: 'עובד/ת בדיקה',
    occupation_title: person['עיסוק'], base_salary: person['שכר בסיס'], commissions: person['עמלות'], bonus: person['בונוס'],
    employee_pension_percent: person['פנסיה עובד %'], employee_study_fund_percent: person['קרן השתלמות עובד %'], tax_credit_points: person['נקודות זיכוי'],
    eligible_children_count: person['ילדים עד 23'], current_vehicle_id: current, current_participation: person['השתתפות היום'],
    created_at: '2026-10-22T08:00:00.000Z', confirmed_at: '2026-10-22T08:00:00.000Z', ...overrides };
}
function deps(profile: EmployeeDataVersionRow | null, overrides: Partial<MatchDependencies> = {}): MatchDependencies {
  return {
    confirmed: vi.fn(async () => profile), occupations: async () => occupations, rules: async () => structuredClone(rules), catalog: async () => catalog,
    vehicles: async ids => new Map(ids.map(id => { const car = cars.find(item => item['מזהה'] === id); return [id, car ? { car, taxYear: 2026 } : null]; })),
    ...overrides
  };
}
async function ready(fixtureId: string, overrides: Partial<EmployeeDataVersionRow> = {}, dependencyOverrides: Partial<MatchDependencies> = {}) {
  const userId = randomUUID();
  const context = await loadMatchContext(userId, deps(profileOf(fixtureId, userId, overrides), dependencyOverrides));
  if (context.status !== 'ready') throw new Error(`expected ready, got ${context.status}`);
  return context;
}
const prefs = (value: MatchPreferences) => matchPreferencesSchema.parse(value);
const allIds = (candidates: MatchCandidate[]) => candidates.map(candidate => candidate.id);

describe('CarWise Match: eligibility comes first and is never relaxed', () => {
  it('offers a group ג employee only own-group or lower vehicles, never ד or the family track without enough children', async () => {
    const context = await ready('E-001');
    const groups = new Set(context.candidates.map(candidate => candidate.group_code));
    expect([...groups].sort()).toEqual(['א', 'ב', 'ג']);
    expect(allIds(context.candidates)).not.toContain(idOf('MODEL 3'));
    expect(allIds(context.candidates)).not.toContain(idOf('CARNIVAL'));
    for (const preferences of [{ powertrain: 'any' }, { powertrain: 'חשמלי', strength: 'soft' }, { powertrain: 'בנזין', strength: 'hard' }] as MatchPreferences[]) {
      for (const item of rankVehicles(context.candidates, prefs(preferences)).recommendations) expect(['א', 'ב', 'ג']).toContain(item.vehicle.group_code);
    }
  });

  it('includes family-track vehicles only when the confirmed profile has enough eligible children', async () => {
    expect(allIds((await ready('E-002')).candidates)).toEqual(expect.arrayContaining([idOf('CARNIVAL'), idOf('SANTA FE')]));
    expect(allIds((await ready('E-002', { eligible_children_count: 3 })).candidates)).not.toContain(idOf('CARNIVAL'));
  });

  it('sends the employee to the confirmation flow without a confirmed profile, a matching role, or their own profile', async () => {
    const userId = randomUUID();
    expect((await loadMatchContext(userId, deps(null))).status).toBe('needs_profile');
    expect((await loadMatchContext(userId, deps(profileOf('E-001', userId, { status: 'draft' })))).status).toBe('needs_profile');
    expect((await loadMatchContext(userId, deps(profileOf('E-001', userId, { occupation_title: 'תפקיד שאינו ברשימה' })))).status).toBe('needs_profile');
    // A repository regression returning another employee's row is never used.
    const foreign = await loadMatchContext(userId, deps(profileOf('E-001', randomUUID())));
    expect(foreign).toEqual({ status: 'needs_profile', reason: expect.any(String) });
  });

  it('reads the profile of the signed-in employee only', async () => {
    const userId = randomUUID();
    const dependencies = deps(profileOf('E-001', userId));
    await loadMatchContext(userId, dependencies);
    expect(dependencies.confirmed).toHaveBeenCalledWith(userId);
    expect(dependencies.confirmed).toHaveBeenCalledTimes(1);
  });

  it('reports data that cannot be loaded as unavailable instead of guessing', async () => {
    const userId = randomUUID();
    expect((await loadMatchContext(userId, deps(profileOf('E-001', userId), { rules: async () => { throw new Error('down'); } }))).status).toBe('unavailable');
  });
});

describe('CarWise Match: financial estimates come only from the existing calculator', () => {
  it('matches the challenge reference result (E-001: COROLLA CROSS → ATTO 3 = +661 ₪)', async () => {
    const context = await ready('E-001');
    const atto = context.candidates.find(candidate => candidate.id === idOf('ATTO 3'))!;
    const reference = references.find(item => item['מזהה'] === 'E-001')!;
    expect(atto.financial).toMatchObject({ status: 'estimate', delta: reference['הפרש'] });
  });

  it('computes every estimate exactly as calculateNet does (rounded per side, no other source)', async () => {
    const context = await ready('E-004');
    const occupation = occupations.find(row => row.title === employees.find(item => item['מזהה'] === 'E-004')!['עיסוק'])!;
    const { toCalculatorEmployee, toCalculatorOccupation } = await import('../src/lib/ai/financial-flow');
    const employee = toCalculatorEmployee(profileOf('E-004', 'x'), occupation);
    const today = cars.find(car => car['מזהה'] === idOf('TUCSON'))!;
    const base = displayShekels(calculateNet(employee, { type: 'car', car: today, participation: employee['השתתפות היום'] }, rules, toCalculatorOccupation(occupation)).net);
    for (const candidate of context.candidates.filter(item => !item.current)) {
      const car = cars.find(item => item['מזהה'] === candidate.id)!;
      expect(candidate.financial).toMatchObject({ status: 'estimate',
        delta: displayShekels(calculateNet(employee, { type: 'car', car }, rules, toCalculatorOccupation(occupation)).net) - base });
    }
  });

  it('labels estimates as provisional and explains the placeholder participation and the tax-year difference', async () => {
    const context = await ready('E-001');
    expect(context.notes.join(' ')).toMatch(/זמני/);
    expect(context.notes.join(' ')).toMatch(/השתתפות העובד/);
    expect(context.notes.join(' ')).toMatch(/2025.*2026/);
    const sameYear = await ready('E-001', {}, { rules: async () => ({ ...structuredClone(rules), netMethod: { ...rules.netMethod, taxYear: 2026 } }) });
    expect(sameYear.notes.join(' ')).not.toMatch(/מדרגות המס/);
  });

  it('never substitutes a missing official tax value: that vehicle has no estimate, the others keep theirs', async () => {
    const missing = idOf('EV3');
    const context = await ready('E-001', {}, { vehicles: async ids => new Map(ids.map(id => [id, id === missing ? null
      : { car: cars.find(item => item['מזהה'] === id)!, taxYear: 2026 }])) });
    expect(context.candidates.find(candidate => candidate.id === missing)!.financial).toMatchObject({ status: 'unavailable' });
    expect(context.candidates.find(candidate => candidate.id === idOf('ATTO 3'))!.financial.status).toBe('estimate');
  });

  it('shows no estimate at all when today\'s car has no official value (no baseline to compare against)', async () => {
    const today = idOf('COROLLA CROSS');
    const context = await ready('E-001', {}, { vehicles: async ids => new Map(ids.map(id => [id, id === today ? null
      : { car: cars.find(item => item['מזהה'] === id)!, taxYear: 2026 }])) });
    expect(context.candidates.every(candidate => candidate.financial.status === 'unavailable')).toBe(true);
    expect(context.notes).toEqual([]);
  });

  it('compares against having no car when the confirmed profile has none', async () => {
    const context = await ready('E-003');
    expect(context.candidates.some(candidate => candidate.current)).toBe(false);
    expect(context.candidates.every(candidate => candidate.financial.status === 'estimate')).toBe(true);
  });
});

describe('CarWise Match: deterministic ranking', () => {
  it('returns at most three, never today\'s car, ordered by the estimate without a powertrain preference', async () => {
    const context = await ready('E-001');
    const outcome = rankVehicles(context.candidates, prefs({ powertrain: 'any' }));
    expect(outcome.recommendations).toHaveLength(3);
    expect(outcome.recommendations.map(item => item.vehicle.id)).not.toContain(idOf('COROLLA CROSS'));
    const deltas = outcome.recommendations.map(item => item.financial.status === 'estimate' ? item.financial.delta : -Infinity);
    expect(deltas).toEqual([...deltas].sort((a, b) => b - a));
    expect(outcome.excluded.current).toBe(1);
  });

  it('applies a hard powertrain preference as a filter and a soft one as an ordering', async () => {
    const context = await ready('E-001');
    const hard = rankVehicles(context.candidates, prefs({ powertrain: 'בנזין', strength: 'hard' }));
    expect(hard.recommendations.every(item => item.vehicle.drive_type === 'בנזין')).toBe(true);
    const soft = rankVehicles(context.candidates, prefs({ powertrain: 'היברידי', strength: 'soft', priority: 'powertrain' }));
    // Group ג employee, today COROLLA CROSS: the only other eligible hybrids are YARIS CROSS and NIRO, then the rest by estimate.
    expect(soft.recommendations.slice(0, 2).map(item => item.vehicle.drive_type)).toEqual(['היברידי', 'היברידי']);
    expect(soft.recommendations[2].fit).toBe('other');
    expect(soft.recommendations[2].tradeoffs.join(' ')).toMatch(/שונה מההעדפה/);
  });

  it('breaks ties by catalog ID, independent of input order', () => {
    const base = { manufacturer_name: 'יצרן', group_code: 'א' as const, drive_type: 'בנזין', eligibilityReason: 'בקבוצה', family: false, current: false,
      financial: { status: 'estimate' as const, delta: 100, electricBonus: 0, familyShare: 0 } };
    const candidates: MatchCandidate[] = ['CAR-03', 'CAR-01', 'CAR-02', 'CAR-04'].map(id => ({ ...base, id, display_name: id }));
    const order = (list: MatchCandidate[]) => rankVehicles(list, prefs({ powertrain: 'any' })).recommendations.map(item => item.vehicle.id);
    expect(order(candidates)).toEqual(['CAR-01', 'CAR-02', 'CAR-03']);
    expect(order([...candidates].reverse())).toEqual(['CAR-01', 'CAR-02', 'CAR-03']);
  });

  it('puts vehicles without an estimate after estimated ones and says why', () => {
    const make = (id: string, financial: MatchCandidate['financial']): MatchCandidate => ({ id, display_name: id, manufacturer_name: 'יצרן', group_code: 'א',
      drive_type: 'בנזין', eligibilityReason: 'בקבוצה', family: false, current: false, financial });
    const outcome = rankVehicles([make('CAR-01', { status: 'unavailable', reason: 'חסר ערך רשמי.' }),
      make('CAR-02', { status: 'estimate', delta: -50, electricBonus: 0, familyShare: 0 })], prefs({ powertrain: 'any' }));
    expect(outcome.recommendations.map(item => item.vehicle.id)).toEqual(['CAR-02', 'CAR-01']);
    expect(outcome.recommendations[1].missing.join(' ')).toContain('חסר ערך רשמי.');
    expect(outcome.recommendations[0].tradeoffs.join(' ')).toMatch(/נמוך מהמצב שלך היום/);
  });

  it('handles fewer than three and no eligible vehicles gracefully', async () => {
    const context = await ready('E-001');
    const electric = rankVehicles(context.candidates, prefs({ powertrain: 'פלאג-אין', strength: 'hard' }));
    expect(electric.recommendations).toEqual([]);
    expect(electric.empty).toMatch(/אין רכב זכאי/);
    expect(rankVehicles([], prefs({ powertrain: 'any' })).empty).toMatch(/לא נמצאו רכבים/);
    const one = rankVehicles(context.candidates.filter(candidate => candidate.id === idOf('ATTO 3') || candidate.current), prefs({ powertrain: 'any' }));
    expect(one.recommendations).toHaveLength(1);
  });

  it('never outputs a percentage score or a value without a source', async () => {
    const context = await ready('E-006');
    const outcome = rankVehicles(context.candidates, prefs({ powertrain: 'חשמלי', strength: 'soft', priority: 'net' }));
    const text = JSON.stringify(outcome);
    expect(text).not.toMatch(/%|ציון|score/i);
    for (const item of outcome.recommendations) {
      expect(Object.keys(item).sort()).toEqual(['evidence', 'financial', 'fit', 'fitLabel', 'label', 'missing', 'profile', 'rank', 'reasons', 'tradeoffs', 'vehicle']);
      expect(['high', 'good', 'partial', null]).toContain(item.fitLabel);
    }
  });
});

describe('CarWise Match: CAR-16 (powertrain under verification)', () => {
  it('never satisfies a hard powertrain preference, whatever it is recorded as', async () => {
    const context = await ready('E-006');
    expect(allIds(context.candidates)).toContain('CAR-16');
    for (const powertrain of ['פלאג-אין', 'היברידי', 'בנזין', 'חשמלי'] as const) {
      const outcome = rankVehicles(context.candidates, prefs({ powertrain, strength: 'hard' }));
      expect(outcome.recommendations.map(item => item.vehicle.id)).not.toContain('CAR-16');
    }
    const plugIn = rankVehicles(context.candidates, prefs({ powertrain: 'פלאג-אין', strength: 'hard' }));
    expect(plugIn.excluded.underReview).toBe(1);
    expect(plugIn.empty).toMatch(/שסיווג ההנעה שלו מאומת/);
  });

  it('with a soft preference it is never ranked as a match, and its classification is shown as unverified', async () => {
    const context = await ready('E-006');
    const outcome = rankVehicles(context.candidates, prefs({ powertrain: 'פלאג-אין', strength: 'soft', priority: 'powertrain' }));
    expect(outcome.recommendations.every(item => item.fit !== 'match')).toBe(true);
    const only = context.candidates.filter(candidate => candidate.id === 'CAR-16');
    const sportage = rankVehicles(only, prefs({ powertrain: 'any' })).recommendations[0];
    expect(sportage.missing.join(' ')).toMatch(/סיווג ההנעה בבדיקה/);
    const asSoftMatch = rankVehicles(only, prefs({ powertrain: 'פלאג-אין', strength: 'soft', priority: 'powertrain' })).recommendations[0];
    expect(asSoftMatch.fit).toBe('unverified');
    expect(asSoftMatch.reasons.join(' ')).not.toMatch(/תואם להעדפה/);
    // The catalog record itself is passed through unchanged.
    expect(context.candidates.find(candidate => candidate.id === 'CAR-16')!.drive_type).toBe('פלאג-אין');
  });
});

describe('CarWise Match: follow-up questions', () => {
  it('asks about priority only when net-first and powertrain-first give different recommendations', async () => {
    const context = await ready('E-001');
    const soft = prefs({ powertrain: 'היברידי', strength: 'soft' });
    const differs = rankVehicles(context.candidates, { ...soft, priority: 'net' }).recommendations.map(item => item.vehicle.id).join()
      !== rankVehicles(context.candidates, { ...soft, priority: 'powertrain' }).recommendations.map(item => item.vehicle.id).join();
    expect(nextQuestion(context.candidates, soft)).toBe(differs ? 'priority' : null);
    expect(nextQuestion(context.candidates, prefs({ powertrain: 'any' }))).toBeNull();
    expect(nextQuestion(context.candidates, prefs({ powertrain: 'היברידי', strength: 'hard' }))).toBeNull();
    expect(nextQuestion(context.candidates, { ...soft, priority: 'net' })).toBeNull();
  });

  it('asks about the family track only for an eligible employee and only when it changes the result', async () => {
    expect(nextQuestion((await ready('E-001')).candidates, prefs({ powertrain: 'any' }))).toBeNull();
    const family = (await ready('E-002')).candidates;
    const changes = rankVehicles(family, prefs({ powertrain: 'any', family: 'include' })).recommendations.map(item => item.vehicle.id).join()
      !== rankVehicles(family, prefs({ powertrain: 'any', family: 'exclude' })).recommendations.map(item => item.vehicle.id).join();
    expect(nextQuestion(family, prefs({ powertrain: 'any' }))).toBe(changes ? 'family' : null);
    expect(nextQuestion(family, prefs({ powertrain: 'any', family: 'exclude' }))).toBeNull();
  });

  it('never asks more than two follow-ups: once both are answered there is nothing left to ask', async () => {
    const family = (await ready('E-002')).candidates;
    expect(nextQuestion(family, prefs({ powertrain: 'חשמלי', strength: 'soft', priority: 'net', family: 'include' }))).toBeNull();
  });
});

describe('CarWise Match: preference input validation', () => {
  it('accepts only the supported, consistent preferences', () => {
    expect(matchPreferencesSchema.safeParse({ powertrain: 'any' }).success).toBe(true);
    expect(matchPreferencesSchema.safeParse({ powertrain: 'חשמלי', strength: 'hard' }).success).toBe(true);
    for (const invalid of [{ powertrain: 'חשמלי' }, { powertrain: 'any', strength: 'hard' }, { powertrain: 'מימן', strength: 'soft' },
      { powertrain: 'חשמלי', strength: 'hard', priority: 'net' }, { powertrain: 'any', seats: 7 }, { powertrain: 'any', eligible: true },
      { powertrain: 'any', userId: randomUUID() }, { powertrain: 'any', family: 'maybe' }]) {
      expect(matchPreferencesSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
