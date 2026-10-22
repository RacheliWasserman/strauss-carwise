import { z } from 'zod';

/**
 * CarWise Match: a pure, deterministic ranking of vehicles the employee is ALREADY eligible for. No model is involved.
 *
 * Sources, never mixed up:
 * - The company catalog, rules and calculator decide identity, eligibility, powertrain and the financial estimate.
 * - The supplemental vehicle profiles (general MODEL-LEVEL information, not verified for the exact trim) are used only
 *   as soft lifestyle signals, always labelled as such. They never satisfy a mandatory requirement and never change
 *   eligibility or money. A missing value stays unknown: it is neither a plus nor a minus.
 */
export const MATCH_POWERTRAINS = ['חשמלי', 'היברידי', 'פלאג-אין', 'בנזין'] as const;
export type MatchPowertrain = typeof MATCH_POWERTRAINS[number];
export const MAX_RECOMMENDATIONS = 3;
export const TRAVELERS = ['solo', 'couple', 'small_family', 'large_family', 'varies'] as const;
export const SEAT_NEEDS = ['2', '4', '5', '7', 'any'] as const;
export const PRIORITIES = ['cost', 'family_space', 'large_trunk', 'long_trips', 'city', 'technology', 'energy'] as const;
export const DRIVING = ['city', 'mixed', 'long', 'all'] as const;
export const DISTANCES = ['low', 'mid', 'high', 'unsure'] as const;
export const CHARGING = ['home', 'work', 'public', 'none', 'unknown'] as const;
export const NEEDS = ['seats5', 'seats7', 'large_trunk', 'compact', 'high_body'] as const;
export const FINANCE = ['net_first', 'balanced', 'fit_first'] as const;
export type Need = typeof NEEDS[number];
export type Priority = typeof PRIORITIES[number];

const unique = <T>(list: T[]) => new Set(list).size === list.length;
export const matchPreferencesSchema = z.object({
  powertrain: z.enum(['any', ...MATCH_POWERTRAINS]),
  /** hard: only this powertrain; soft: preferred, others may follow. */
  strength: z.enum(['hard', 'soft']).optional(),
  /** Earlier single question (net vs powertrain); superseded by `finance` when that is answered. */
  priority: z.enum(['net', 'powertrain']).optional(),
  family: z.enum(['include', 'exclude']).optional(),
  travelers: z.enum(TRAVELERS).optional(),
  seats: z.enum(SEAT_NEEDS).optional(),
  priorities: z.array(z.enum(PRIORITIES)).max(3).refine(unique).optional(),
  driving: z.enum(DRIVING).optional(),
  distance: z.enum(DISTANCES).optional(),
  charging: z.enum(CHARGING).optional(),
  needs: z.array(z.enum(NEEDS)).max(NEEDS.length).refine(unique).optional(),
  needsStrength: z.enum(['hard', 'soft']).optional(),
  finance: z.enum(FINANCE).optional()
}).strict().refine(value => value.powertrain === 'any' ? !value.strength && !value.priority : Boolean(value.strength),
  { message: 'A powertrain preference needs its strength' })
  .refine(value => !value.priority || value.strength === 'soft', { message: 'Priority applies to a soft preference only' })
  .refine(value => !value.needsStrength || Boolean(value.needs?.length), { message: 'Requirement strength needs requirements' });
export type MatchPreferences = z.infer<typeof matchPreferencesSchema>;

/**
 * Vehicles whose recorded powertrain is under verification. They never satisfy a powertrain preference until the
 * record is verified; the record itself is not changed or reinterpreted here.
 */
export const POWERTRAIN_UNDER_REVIEW: Readonly<Record<string, string>> = {
  'CAR-16': 'סיווג ההנעה בבדיקה: שם הדגם (HEV) אינו תואם לסיווג שברשומה (פלאג־אין), ולכן הרכב לא נחשב כמתאים להעדפת הנעה עד לאימות.'
};

/** General model-level characteristics (not verified for the exact trim). Absent = unknown. */
export type VehicleProfile = {
  bodyType?: 'hatchback' | 'sedan' | 'small_suv' | 'suv' | 'crossover' | 'minivan';
  seats?: number; trunkLiters?: number;
  /** Indicative across versions; shown for information only, never ranked. */
  rangeKm?: { min: number; max: number };
  typicalUse?: 'city' | 'mixed' | 'long_distance' | 'family';
  sizeClass?: 'small' | 'compact' | 'family' | 'large_family';
};
export type MatchFinancial =
  | { status: 'estimate'; delta: number; electricBonus: number; familyShare: number }
  | { status: 'unavailable'; reason: string };
/** One vehicle the server already found eligible with the employee's confirmed profile and the official rules. */
export type MatchCandidate = {
  id: string; display_name: string; manufacturer_name: string; group_code: 'א' | 'ב' | 'ג' | 'ד' | 'משפחתי'; drive_type: string;
  registration_year?: number; eligibilityReason: string; family: boolean; current: boolean; financial: MatchFinancial;
  profile?: VehicleProfile;
};
export type PowertrainFit = 'not_requested' | 'match' | 'other' | 'unverified';
export type FitLabel = 'high' | 'good' | 'partial';
export type CardLabel = 'top' | 'value' | 'more';
export type MatchRecommendation = {
  rank: number; label: CardLabel;
  vehicle: Pick<MatchCandidate, 'id' | 'display_name' | 'manufacturer_name' | 'group_code' | 'drive_type' | 'registration_year'>;
  profile: VehicleProfile;
  fit: PowertrainFit;
  /** Qualitative only, and only when enough of the employee's criteria had data. Never a percentage. */
  fitLabel: FitLabel | null;
  /** How many of the employee's criteria could be checked for this vehicle. */
  evidence: { known: number; total: number };
  financial: MatchFinancial; reasons: string[]; tradeoffs: string[]; missing: string[];
};
export type MatchOutcome = {
  recommendations: MatchRecommendation[];
  /** Eligible vehicles that remained after the employee's own filters. */
  considered: number;
  excluded: { current: number; family: number; powertrain: number; underReview: number; requirement: number };
  /** Preferences the data cannot evaluate (said once, not per vehicle). */
  unsupported: string[];
  empty?: string;
};
export type MatchQuestion = 'priority' | 'family';

const POWERTRAIN_LABEL: Record<string, string> = { 'חשמלי': 'חשמלי', 'היברידי': 'היברידי', 'פלאג-אין': 'פלאג־אין', 'בנזין': 'בנזין' };
export const powertrainLabel = (value: string) => POWERTRAIN_LABEL[value] ?? value;
export const NEED_LABEL: Record<Need, string> = { seats5: 'לפחות 5 מקומות', seats7: '7 מקומות ומעלה', large_trunk: 'תא מטען גדול',
  compact: 'רכב קומפקטי לעיר', high_body: 'מרכב גבוה / SUV' };
export const BODY_LABEL: Record<NonNullable<VehicleProfile['bodyType']>, string> = { hatchback: 'האצ׳בק', sedan: 'סדאן', small_suv: 'קרוסאובר קטן',
  suv: 'SUV', crossover: 'קרוסאובר', minivan: 'מיניוואן' };
const TRAVELER_LABEL: Record<typeof TRAVELERS[number], string> = { solo: 'נסיעה לבד', couple: 'זוג', small_family: 'משפחה קטנה',
  large_family: 'משפחה גדולה', varies: 'מספר נוסעים משתנה' };
const MODEL_LEVEL = 'לפי מאפייני הדגם הכלליים';
const shekels = (value: number) => `${Math.abs(Math.round(value)).toLocaleString('he-IL')} ₪`;

/** Documented product assumptions (starting values, not business facts). */
export const LARGE_TRUNK_LITERS = 450;
export const BASE_WEIGHTS = { practical: 0.25, driving: 0.20, financial: 0.25, powertrain: 0.20, other: 0.10 } as const;
export const FIT_LABEL_MIN_COVERAGE = 0.6;
type Dimension = keyof typeof BASE_WEIGHTS;
const HIGH_BODIES = ['suv', 'small_suv', 'crossover', 'minivan'];

export function powertrainFit(candidate: Pick<MatchCandidate, 'id' | 'drive_type'>, preferences: MatchPreferences): PowertrainFit {
  if (preferences.powertrain === 'any') return 'not_requested';
  if (POWERTRAIN_UNDER_REVIEW[candidate.id]) return 'unverified';
  return candidate.drive_type === preferences.powertrain ? 'match' : 'other';
}

/** A mandatory requirement against model-level data: contradicted vehicles are excluded; the rest are never "verified". */
export function requirementStatus(need: Need, profile: VehicleProfile = {}): 'consistent' | 'contradicted' | 'unknown' {
  const check = (value: unknown, ok: boolean) => value === undefined ? 'unknown' : ok ? 'consistent' : 'contradicted';
  switch (need) {
    case 'seats5': return check(profile.seats, (profile.seats ?? 0) >= 5);
    case 'seats7': return check(profile.seats, (profile.seats ?? 0) >= 7);
    case 'large_trunk': return check(profile.trunkLiters, (profile.trunkLiters ?? 0) >= LARGE_TRUNK_LITERS);
    case 'compact': return check(profile.sizeClass, ['small', 'compact'].includes(profile.sizeClass ?? ''));
    case 'high_body': return check(profile.bodyType, HIGH_BODIES.includes(profile.bodyType ?? ''));
  }
}

function seatsNeeded(preferences: MatchPreferences) {
  const fromQuestion = preferences.seats && preferences.seats !== 'any' ? Number(preferences.seats) : 0;
  const fromNeeds = preferences.needsStrength !== 'hard' ? Math.max(preferences.needs?.includes('seats7') ? 7 : 0, preferences.needs?.includes('seats5') ? 5 : 0) : 0;
  return Math.max(fromQuestion, fromNeeds);
}

/** info: said to the employee but not a criterion (never scored, never counted as evidence). */
type Signal = { dimension: Dimension; score: number | null; reason?: string; tradeoff?: string; missing?: string; info?: boolean };

/** Every criterion the employee expressed, evaluated for one vehicle. null = no usable data for it. */
function signals(candidate: MatchCandidate, preferences: MatchPreferences, pool: { deltas: number[] }): Signal[] {
  const profile = candidate.profile ?? {};
  const list: Signal[] = [];
  const priorities = preferences.priorities ?? [];
  const soft = preferences.needsStrength !== 'hard' ? preferences.needs ?? [] : [];
  const drive = POWERTRAIN_UNDER_REVIEW[candidate.id] ? null : candidate.drive_type;

  // Practical / family.
  const seats = seatsNeeded(preferences);
  if (seats > 0) list.push(profile.seats === undefined
    ? { dimension: 'practical', score: null, missing: 'אין נתון על מספר המושבים.' }
    : profile.seats >= seats
      ? { dimension: 'practical', score: 1, reason: `${profile.seats} מקומות ישיבה — מספיק לצורך שציינת (${MODEL_LEVEL}).` }
      : { dimension: 'practical', score: 0, tradeoff: `${profile.seats} מקומות ישיבה (${MODEL_LEVEL}) — פחות מ־${seats} שציינת.` });
  const family = preferences.travelers === 'small_family' || preferences.travelers === 'large_family' || priorities.includes('family_space');
  if (family) {
    const large = preferences.travelers === 'large_family';
    const scale = large ? { small: 0, compact: 0.4, family: 0.85, large_family: 1 } : { small: 0.2, compact: 0.6, family: 1, large_family: 1 };
    const who = preferences.travelers === 'small_family' || preferences.travelers === 'large_family' ? TRAVELER_LABEL[preferences.travelers] : 'משפחה';
    list.push(profile.sizeClass === undefined ? { dimension: 'practical', score: null, missing: 'אין נתון על גודל הרכב.' }
      : { dimension: 'practical', score: scale[profile.sizeClass],
        reason: scale[profile.sizeClass] >= 0.85 ? `דגם בגודל ${profile.sizeClass === 'large_family' ? 'משפחתי גדול' : 'משפחתי'} — מתאים ל${who} (${MODEL_LEVEL}).` : undefined,
        tradeoff: scale[profile.sizeClass] <= 0.4 ? `דגם ${profile.sizeClass === 'small' ? 'קטן' : 'קומפקטי'} יחסית ל${who} (${MODEL_LEVEL}).` : undefined });
  }
  if (priorities.includes('large_trunk') || soft.includes('large_trunk') || preferences.travelers === 'large_family') {
    // Absolute documented scale: 300 L → 0, 600 L → 1.
    const trunk = profile.trunkLiters;
    list.push(trunk === undefined ? { dimension: 'practical', score: null, missing: 'אין נתון על נפח תא המטען.' }
      : { dimension: 'practical', score: Math.min(1, Math.max(0, (trunk - 300) / 300)),
        reason: trunk >= LARGE_TRUNK_LITERS ? `תא מטען של כ־${trunk} ליטר (${MODEL_LEVEL}).` : undefined,
        tradeoff: trunk < 400 ? `תא מטען של כ־${trunk} ליטר בלבד (${MODEL_LEVEL}).` : undefined });
  }

  // Driving habits.
  if (preferences.driving === 'city' || priorities.includes('city')) {
    const scale = { small: 1, compact: 0.8, family: 0.4, large_family: 0.1 };
    list.push(profile.sizeClass === undefined ? { dimension: 'driving', score: null, missing: 'אין נתון על גודל הרכב.' }
      : { dimension: 'driving', score: scale[profile.sizeClass],
        reason: scale[profile.sizeClass] >= 0.8 ? `דגם ${profile.sizeClass === 'small' ? 'קטן' : 'קומפקטי'} — נוח לתמרון ולחניה בעיר (${MODEL_LEVEL}).` : undefined,
        tradeoff: scale[profile.sizeClass] <= 0.4 ? `רכב גדול יחסית לנסיעות ולחניה בעיר (${MODEL_LEVEL}).` : undefined });
  }
  if (preferences.driving === 'long' || priorities.includes('long_trips') || preferences.distance === 'high') {
    const scale = { long_distance: 1, family: 0.6, mixed: 0.6, city: 0.1 };
    list.push(profile.typicalUse === undefined ? { dimension: 'driving', score: null, missing: 'אין נתון על אופי השימוש בדגם.' }
      : { dimension: 'driving', score: scale[profile.typicalUse],
        reason: profile.typicalUse === 'long_distance' ? `מאופיין כרכב לנסיעות ארוכות (${MODEL_LEVEL}).` : undefined,
        tradeoff: profile.typicalUse === 'city' ? `מאופיין בעיקר כרכב עירוני (${MODEL_LEVEL}).` : undefined });
  }
  if (preferences.driving === 'mixed' || preferences.driving === 'all') {
    const scale = { mixed: 1, long_distance: 0.8, family: 0.8, city: 0.5 };
    list.push(profile.typicalUse === undefined ? { dimension: 'driving', score: null, missing: 'אין נתון על אופי השימוש בדגם.' }
      : { dimension: 'driving', score: scale[profile.typicalUse],
        reason: profile.typicalUse === 'mixed' ? `מתאים לשילוב של עיר ובין־עירוני (${MODEL_LEVEL}).` : undefined });
  }

  // Financial: the calculator's estimate, relative to the other vehicles considered.
  const financial = candidate.financial;
  if (financial.status === 'estimate') {
    const min = Math.min(...pool.deltas), max = Math.max(...pool.deltas);
    list.push({ dimension: 'financial', score: max === min ? 1 : (financial.delta - min) / (max - min) });
  } else list.push({ dimension: 'financial', score: null });

  // Powertrain and charging (catalog powertrain only; CAR-16 stays unknown).
  if (preferences.powertrain !== 'any' && preferences.strength === 'soft') {
    const fit = powertrainFit(candidate, preferences);
    list.push({ dimension: 'powertrain', score: fit === 'match' ? 1 : fit === 'other' ? 0 : null,
      reason: fit === 'match' ? `סוג ההנעה (${powertrainLabel(candidate.drive_type)}) תואם להעדפה שלך.` : undefined,
      tradeoff: fit === 'other' ? `סוג ההנעה (${powertrainLabel(candidate.drive_type)}) שונה מההעדפה שלך (${powertrainLabel(preferences.powertrain)}).` : undefined });
  }
  const charging = preferences.charging;
  if (charging && charging !== 'unknown') {
    if (!drive) list.push({ dimension: 'powertrain', score: null });
    else if (drive === 'חשמלי') {
      const scale = { home: 1, work: 0.8, public: 0.45, none: 0.1 };
      list.push({ dimension: 'powertrain', score: scale[charging],
        reason: charging === 'home' ? 'יש לך טעינה בבית — מה שהופך רכב חשמלי לנוח ביום־יום.' : charging === 'work' ? 'טעינה בעבודה מאפשרת שימוש נוח ברכב חשמלי.' : undefined,
        tradeoff: charging === 'none' ? 'רכב חשמלי דורש טעינה, וציינת שאין לך אפשרות טעינה קבועה.'
          : charging === 'public' ? 'עם טעינה ציבורית בלבד, רכב חשמלי מחייב תכנון של זמני טעינה.' : undefined });
    } else if (drive === 'פלאג-אין') {
      const scale = { home: 1, work: 0.85, public: 0.7, none: 0.5 };
      list.push({ dimension: 'powertrain', score: scale[charging],
        tradeoff: charging === 'none' ? 'בלי טעינה קבועה, רכב פלאג־אין ייסע בעיקר על בנזין.' : undefined });
    } else list.push({ dimension: 'powertrain', score: 1,
      reason: charging === 'none' ? 'לא נדרשת טעינה — מתאים כשאין אפשרות טעינה קבועה.' : undefined });
  }
  if (drive === 'חשמלי' && preferences.distance === 'high') {
    // Range is indicative across versions and not ranked; the uncertainty is said, not scored.
    list.push({ dimension: 'powertrain', score: null, info: true, tradeoff: `ציינת מעל 2,000 ק״מ בחודש, והטווח המדויק של הגרסה הזו אינו ידוע${profile.rangeKm
      ? ` (לדגם באופן כללי ${profile.rangeKm.min === profile.rangeKm.max ? profile.rangeKm.min : `${profile.rangeKm.min}–${profile.rangeKm.max}`} ק״מ, לא מאומת)` : ''}.` });
  }

  // Other supported preferences: body style and size as a preference.
  if (soft.includes('compact')) {
    const status = requirementStatus('compact', profile);
    list.push({ dimension: 'other', score: status === 'unknown' ? null : status === 'consistent' ? 1 : 0,
      reason: status === 'consistent' ? `רכב קומפקטי (${MODEL_LEVEL}).` : undefined, missing: status === 'unknown' ? 'אין נתון על גודל הרכב.' : undefined });
  }
  if (soft.includes('high_body')) {
    const status = requirementStatus('high_body', profile);
    list.push({ dimension: 'other', score: status === 'unknown' ? null : status === 'consistent' ? 1 : 0,
      reason: status === 'consistent' && profile.bodyType ? `מרכב ${BODY_LABEL[profile.bodyType]} (${MODEL_LEVEL}).` : undefined,
      missing: status === 'unknown' ? 'אין נתון על סוג המרכב.' : undefined });
  }
  return list;
}

function weights(preferences: MatchPreferences): Record<Dimension, number> {
  const weight: Record<Dimension, number> = { ...BASE_WEIGHTS };
  for (const priority of preferences.priorities ?? []) {
    if (priority === 'cost') weight.financial += 0.15;
    if (priority === 'family_space' || priority === 'large_trunk') weight.practical += 0.15;
    if (priority === 'long_trips' || priority === 'city') weight.driving += 0.15;
  }
  const finance = preferences.finance ?? (preferences.priority === 'net' ? 'net_first' : undefined);
  if (finance === 'net_first') weight.financial *= 2;
  if (finance === 'fit_first') weight.financial *= 0.5;
  if (!preferences.finance && preferences.priority === 'powertrain') weight.powertrain *= 2;
  return weight;
}

type Scored = { candidate: MatchCandidate; score: number | null; coverage: number; known: number; total: number;
  unknownRequirements: Need[]; signals: Signal[] };

function score(candidate: MatchCandidate, preferences: MatchPreferences, pool: { deltas: number[] }, hard: Need[]): Scored {
  const list = signals(candidate, preferences, pool);
  const weight = weights(preferences);
  const byDimension = new Map<Dimension, Signal[]>();
  const scoring = list.filter(item => !item.info);
  for (const item of scoring) byDimension.set(item.dimension, [...(byDimension.get(item.dimension) ?? []), item]);
  let sum = 0, knownWeight = 0, totalWeight = 0;
  for (const [dimension, items] of byDimension) {
    totalWeight += weight[dimension];
    const known = items.filter(item => item.score !== null);
    if (!known.length) continue;
    knownWeight += weight[dimension];
    sum += weight[dimension] * known.reduce((total, item) => total + item.score!, 0) / known.length;
  }
  return { candidate, score: knownWeight ? sum / knownWeight : null, coverage: totalWeight ? knownWeight / totalWeight : 0,
    known: scoring.filter(item => item.score !== null).length, total: scoring.length,
    unknownRequirements: hard.filter(need => requirementStatus(need, candidate.profile) === 'unknown'), signals: list };
}

function byNet(a: MatchCandidate, b: MatchCandidate) {
  const x = a.financial.status === 'estimate' ? a.financial.delta : null;
  const y = b.financial.status === 'estimate' ? b.financial.delta : null;
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}

export function rankVehicles(candidates: MatchCandidate[], preferences: MatchPreferences): MatchOutcome {
  const excluded = { current: 0, family: 0, powertrain: 0, underReview: 0, requirement: 0 };
  const hard = preferences.needsStrength === 'hard' ? preferences.needs ?? [] : [];
  const pool = candidates.filter(candidate => {
    if (candidate.current) { excluded.current++; return false; }
    if (candidate.family && preferences.family === 'exclude') { excluded.family++; return false; }
    if (preferences.powertrain !== 'any' && preferences.strength === 'hard') {
      const fit = powertrainFit(candidate, preferences);
      if (fit === 'unverified') { excluded.underReview++; return false; }
      if (fit !== 'match') { excluded.powertrain++; return false; }
    }
    // A mandatory requirement that the model-level data contradicts excludes the vehicle (never quietly ignored).
    if (hard.some(need => requirementStatus(need, candidate.profile) === 'contradicted')) { excluded.requirement++; return false; }
    return true;
  });
  const deltas = pool.flatMap(candidate => candidate.financial.status === 'estimate' ? [candidate.financial.delta] : []);
  const scored = pool.map(candidate => score(candidate, preferences, { deltas }, hard)).sort((a, b) =>
    a.unknownRequirements.length - b.unknownRequirements.length
    // Vehicles with enough evidence for the employee's criteria come first; unknown data is not scored, only not preferred.
    || Number(a.coverage < FIT_LABEL_MIN_COVERAGE) - Number(b.coverage < FIT_LABEL_MIN_COVERAGE)
    || (a.score === null ? (b.score === null ? 0 : 1) : b.score === null ? -1 : b.score - a.score)
    || b.coverage - a.coverage || byNet(a.candidate, b.candidate) || a.candidate.id.localeCompare(b.candidate.id));

  const top = scored.slice(0, MAX_RECOMMENDATIONS);
  const estimated = pool.filter(candidate => candidate.financial.status === 'estimate');
  const best = estimated.length ? estimated.reduce((winner, item) => byNet(item, winner) < 0 ? item : winner) : undefined;
  const bestOtherPowertrain = preferences.powertrain === 'any' ? undefined
    : estimated.filter(candidate => powertrainFit(candidate, preferences) !== 'match').sort(byNet)[0];
  const trunkActive = Boolean(preferences.priorities?.includes('large_trunk') || preferences.needs?.includes('large_trunk') || preferences.travelers === 'large_family');
  const largestTrunk = Math.max(0, ...top.map(item => item.candidate.profile?.trunkLiters ?? 0));
  const topDelta = (item?: Scored) => item?.candidate.financial.status === 'estimate' ? item.candidate.financial.delta : null;
  const bestRecDelta = Math.max(...top.map(item => topDelta(item) ?? -Infinity));

  const recommendations = top.map((item, index): MatchRecommendation => {
    const candidate = item.candidate;
    const fit = powertrainFit(candidate, preferences);
    const fitLabel: FitLabel | null = item.score === null || item.coverage < FIT_LABEL_MIN_COVERAGE ? null
      : item.score >= 0.75 ? 'high' : item.score >= 0.55 ? 'good' : 'partial';
    const reasons: string[] = []; const tradeoffs: string[] = []; const missing: string[] = [];
    const weight = weights(preferences);
    const strongest = item.signals.filter(signal => signal.reason && (signal.score ?? 0) >= 0.7)
      .sort((a, b) => weight[b.dimension] * (b.score ?? 0) - weight[a.dimension] * (a.score ?? 0));
    for (const signal of strongest.slice(0, 3)) reasons.push(signal.reason!);
    for (const signal of item.signals) {
      if (signal.tradeoff) tradeoffs.push(signal.tradeoff);
      if (signal.missing && !missing.includes(signal.missing)) missing.push(signal.missing);
    }
    if (POWERTRAIN_UNDER_REVIEW[candidate.id]) missing.push(POWERTRAIN_UNDER_REVIEW[candidate.id]);
    for (const need of hard) {
      const status = requirementStatus(need, candidate.profile);
      missing.push(status === 'unknown' ? `לא ידוע אם הרכב עומד בדרישת החובה "${NEED_LABEL[need]}" — אין נתון. יש לוודא לפני בחירה.`
        : `דרישת החובה "${NEED_LABEL[need]}" נבדקה רק מול מידע כללי על הדגם ולא אומתה לגרסה המדויקת.`);
    }
    const financial = candidate.financial;
    if (financial.status === 'estimate') {
      reasons.push(financial.delta === 0 ? 'אומדן: ללא שינוי בנטו החודשי לעומת היום.'
        : `אומדן: הנטו החודשי ${financial.delta > 0 ? 'יעלה' : 'יירד'} בכ־${shekels(financial.delta)} לעומת היום.`);
      if (financial.electricBonus > 0) reasons.push(`כולל תוספת רכב חשמלי של כ־${shekels(financial.electricBonus)} נטו לפי כללי החברה.`);
      if (best && best.id === candidate.id && estimated.length > 1) reasons.push('האומדן הגבוה ביותר בנטו מבין הרכבים שנבדקו.');
      if (financial.delta < 0) tradeoffs.push('לפי האומדן הנטו יהיה נמוך מהמצב שלך היום.');
      if (financial.familyShare > 0) tradeoffs.push(`במסלול המשפחתי מנוכה מהנטו חלק העובד בפער מעל התקציב (כ־${shekels(financial.familyShare)} בחודש).`);
      if (fit === 'match' && bestOtherPowertrain?.financial.status === 'estimate' && bestOtherPowertrain.financial.delta > financial.delta) {
        tradeoffs.push(`לרכב זכאי בהנעה אחרת (${bestOtherPowertrain.display_name}) יש אומדן נטו גבוה יותר.`);
      } else if (bestRecDelta > financial.delta && top.length > 1) tradeoffs.push('לאחת האפשרויות האחרות שהוצגו יש אומדן נטו גבוה יותר.');
    } else missing.push(`השפעה על הנטו: ${financial.reason}`);
    const trunk = candidate.profile?.trunkLiters;
    if (trunkActive && trunk !== undefined && largestTrunk - trunk >= 50) tradeoffs.push(`תא מטען קטן יחסית לאפשרויות האחרות שהוצגו (כ־${trunk} מול ${largestTrunk} ליטר, ${MODEL_LEVEL}).`);
    const delta = topDelta(item);
    const label: CardLabel = index === 0 && (fitLabel === 'high' || fitLabel === 'good') ? 'top'
      : index > 0 && delta !== null && delta === bestRecDelta && (topDelta(top[0]) === null || delta > topDelta(top[0])!) ? 'value' : 'more';
    return { rank: index + 1, label, fit, fitLabel, evidence: { known: item.known, total: item.total }, financial,
      vehicle: { id: candidate.id, display_name: candidate.display_name, manufacturer_name: candidate.manufacturer_name,
        group_code: candidate.group_code, drive_type: candidate.drive_type, registration_year: candidate.registration_year },
      profile: candidate.profile ?? {}, reasons: [...new Set(reasons)].slice(0, 5), tradeoffs: [...new Set(tradeoffs)], missing };
  });

  const unsupported: string[] = [];
  if (preferences.priorities?.includes('technology')) unsupported.push('אין בקטלוג נתוני אבזור וטכנולוגיה, ולכן ההעדפה "טכנולוגיה ואבזור" לא השפיעה על הדירוג.');
  if (preferences.priorities?.includes('energy')) unsupported.push('אין נתוני צריכת דלק או חשמל לגרסאות שבקטלוג, ולכן ההעדפה "חיסכון בדלק או בחשמל" לא השפיעה על הדירוג. ההשפעה הכספית מוצגת באומדן הנטו.');
  if (preferences.priorities?.includes('long_trips')) unsupported.push('אין נתוני נוחות או בטיחות; "נוחות לנסיעות ארוכות" הוערכה רק לפי אופי השימוש הכללי בדגם.');

  let empty: string | undefined;
  if (!recommendations.length) {
    if (!candidates.length) empty = 'לא נמצאו רכבים בקטלוג הפעיל שכלולים בזכאות שלך לפי הפרופיל המאושר.';
    else if (excluded.requirement) empty = `אין רכב שכלול בזכאות שלך ושעומד בדרישות החובה (${hard.map(need => NEED_LABEL[need]).join(', ')}) לפי המידע הכללי על הדגמים. אפשר להפוך את הדרישה להעדפה.`;
    else if (excluded.powertrain || excluded.underReview) {
      empty = `אין רכב זכאי בהנעה ${powertrainLabel(preferences.powertrain)}${excluded.underReview ? ' שסיווג ההנעה שלו מאומת' : ''}. ` +
        'אפשר לשנות את ההעדפה ל"עדיפות" כדי לראות את החלופות הקרובות.';
    } else if (excluded.family) empty = 'בלי רכבי המסלול המשפחתי לא נשארו רכבים זכאים. אפשר לכלול את המסלול המשפחתי.';
    else empty = 'הרכב היחיד שכלול בזכאות שלך הוא הרכב שיש לך היום.';
  }
  return { recommendations, considered: pool.length, excluded, unsupported, empty };
}

/**
 * The next clarification, only when its answer changes which vehicles are recommended (or their order). At most two
 * exist (priority and family), so at most two follow-ups are ever asked.
 */
export function nextQuestion(candidates: MatchCandidate[], preferences: MatchPreferences): MatchQuestion | null {
  const top = (value: MatchPreferences) => rankVehicles(candidates, value).recommendations.map(item => item.vehicle.id).join(',');
  if (!preferences.finance && preferences.powertrain !== 'any' && preferences.strength === 'soft' && !preferences.priority &&
    top({ ...preferences, priority: 'net' }) !== top({ ...preferences, priority: 'powertrain' })) return 'priority';
  if (!preferences.family && candidates.some(candidate => candidate.family && !candidate.current) &&
    top({ ...preferences, family: 'include' }) !== top({ ...preferences, family: 'exclude' })) return 'family';
  return null;
}

/** The API response the Match screen renders (all values computed on the server). */
export type MatchResponse =
  | { status: 'needs_profile'; reason: string }
  | { status: 'ready'; basis: { occupation: string; group: string }; powertrains: MatchPowertrain[]; notes: string[];
      outcome: MatchOutcome; question: MatchQuestion | null };
