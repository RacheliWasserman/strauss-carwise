import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchPreferencesSchema, rankVehicles, toggleCharging, type MatchCandidate, type ChargingAccess } from '../src/lib/match/match-engine';

vi.mock('@/lib/catalog/showroom', () => import('../src/lib/catalog/showroom'));
vi.mock('@/lib/match/match-engine', () => import('../src/lib/match/match-engine'));
vi.mock('../src/components/chat/chat-sidebar', () => ({ ChatSidebar: () => null }));
vi.mock('../src/components/chat/use-employee-chat', () => ({ rememberActiveConversation: vi.fn() }));
vi.mock('../src/components/chat/use-conversation-list', () => ({ useConversationList: vi.fn() }));
import { Choice, StepFrame, STEPS, summaryRows, toPreferences } from '../src/components/match/match-app';

afterEach(() => vi.unstubAllGlobals());
const answers = { priorities: [], charging: ['home', 'work'] as ChargingAccess[], powertrain: 'חשמלי' as const, strength: 'hard' as const };
const candidate = (id: string, drive_type: string): MatchCandidate => ({ id, drive_type, display_name: id, manufacturer_name: 'Test',
  group_code: 'א', eligibilityReason: 'test', current: false, family: false, financial: { status: 'unavailable', reason: 'test' }, profile: {} });

describe('charging multi-selection', () => {
  it('combines home, work and public, and toggles one without losing the others', () => {
    let values: ChargingAccess[] = [];
    for (const value of ['home', 'work', 'public'] as const) values = toggleCharging(values, value);
    expect(values).toEqual(['home', 'work', 'public']);
    expect(toggleCharging(values, 'work')).toEqual(['home', 'public']);
    expect(matchPreferencesSchema.parse({ powertrain: 'any', charging: values }).charging).toEqual(values);
  });
  it('keeps none and unknown exclusive in both directions', () => {
    expect(toggleCharging(['home', 'work'], 'none')).toEqual(['none']);
    expect(toggleCharging(['none'], 'unknown')).toEqual(['unknown']);
    expect(toggleCharging(['unknown'], 'public')).toEqual(['public']);
    expect(toggleCharging(['none'], 'none')).toEqual([]);
  });
  it.each([['home', 'none'], ['unknown', 'work'], ['none', 'unknown'], ['home', 'home'], ['solar']].map(charging => ({ charging })))('rejects contradictory or invalid charging input $charging', ({ charging }) => {
    expect(matchPreferencesSchema.safeParse({ powertrain: 'any', charging }).success).toBe(false);
  });
  it('scores the strongest charging access only once regardless of input order', () => {
    const cars = [candidate('EV', 'חשמלי'), candidate('PETROL', 'בנזין')];
    const rank = (charging: ChargingAccess[]) => rankVehicles(cars, { powertrain: 'any', charging });
    expect(rank(['work', 'public', 'home'])).toEqual(rank(['home']));
    expect(rank(['public', 'work'])).toEqual(rank(['work']));
  });
  it('never softens hard powertrain choice, even without fixed charging', () => {
    const outcome = rankVehicles([candidate('EV', 'חשמלי'), candidate('PETROL', 'בנזין')],
      { powertrain: 'חשמלי', strength: 'hard', charging: ['none'] });
    expect(outcome.recommendations.map(item => item.vehicle.id)).toEqual(['EV']);
  });
});

describe('five-step questionnaire and summary', () => {
  const render = (element: React.ReactElement) => { vi.stubGlobal('React', React); return renderToStaticMarkup(element); };
  it('uses five steps with finance immediately after powertrain', () => {
    expect(STEPS.map(step => step.id)).toEqual(['travelers', 'priorities', 'driving', 'powertrain', 'finance']);
    const html = render(React.createElement(StepFrame, { index: 4, title: 'בדיקה', onBack: () => {}, onNext: () => {}, children: null }));
    expect(html).toContain('שלב 5 מתוך 5');
    expect(html).not.toContain('דרישות');
  });
  it('keeps all charging selections and hard preferences in submitted answers and editable summary', () => {
    const preferences = toPreferences({ ...answers, seats: '7', seatsStrength: 'hard' });
    expect(matchPreferencesSchema.safeParse(preferences).success).toBe(true);
    expect(preferences).toMatchObject({ charging: ['home', 'work'], strength: 'hard', seats: '7', seatsStrength: 'hard' });
    const rows = summaryRows(answers, ['חשמלי']);
    expect(rows).toHaveLength(5);
    expect(rows.find(row => row.step === 'powertrain')?.value).toContain('יש טעינה בבית · יש טעינה בעבודה');
    expect(rows.map(row => row.step)).toEqual(STEPS.map(step => step.id));
    expect(preferences).not.toHaveProperty('needs');
  });
  it('renders selectable cards as checked native keyboard-operable buttons', () => {
    const html = render(React.createElement(Choice, { multi: true, label: 'יש טעינה בבית', selected: true, onSelect: () => {} }));
    expect(html).toContain('type="button"');
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('cw-match-choice-on');
  });
  it('rejects obsolete questionnaire state and orphan seat strengths', () => {
    for (const fields of [{ needs: ['compact'] }, { needsStrength: 'hard' }, { seatsStrength: 'hard' }, { seats: 'any', seatsStrength: 'hard' }]) {
      expect(matchPreferencesSchema.safeParse({ powertrain: 'any', ...fields }).success).toBe(false);
    }
  });
});
