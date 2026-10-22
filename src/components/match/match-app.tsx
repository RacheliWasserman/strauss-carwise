'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChatSidebar } from '../chat/chat-sidebar';
import { ChatIcon, type ChatIconName } from '../chat/chat-icon';
import { rememberActiveConversation } from '../chat/use-employee-chat';
import type { EmployeeAccount } from '../chat/employee-chat';
import { useConversationList } from '../catalog/catalog-app';
import { VehiclePhoto } from '../catalog/vehicle-photo';
import { CarWiseCarLoader } from '../ui/carwise-car-loader';
import { FAMILY_GROUP, groupLabel, netImpactHref, propulsion } from '@/lib/catalog/showroom';
import { BODY_LABEL, NEED_LABEL, POWERTRAIN_UNDER_REVIEW, powertrainLabel, type CHARGING, type DISTANCES, type DRIVING, type FINANCE,
  type MatchPowertrain, type MatchPreferences, type MatchQuestion, type MatchRecommendation, type MatchResponse, type Need, type Priority,
  type SEAT_NEEDS, type TRAVELERS } from '@/lib/match/match-engine';
import '../chat/employee-chat.css';
import '../catalog/catalog.css';
import './match.css';

type Ready = Extract<MatchResponse, { status: 'ready' }>;
/** The questionnaire as the employee fills it in; turned into validated preferences only on submit. */
type Answers = {
  travelers?: typeof TRAVELERS[number]; seats?: typeof SEAT_NEEDS[number]; priorities: Priority[];
  driving?: typeof DRIVING[number]; distance?: typeof DISTANCES[number]; charging?: typeof CHARGING[number];
  powertrain: 'any' | MatchPowertrain; strength: 'hard' | 'soft'; needs: Need[]; needsStrength: 'hard' | 'soft';
  finance?: typeof FINANCE[number]; family?: 'include' | 'exclude'; priority?: 'net' | 'powertrain';
};
type StepId = 'travelers' | 'priorities' | 'driving' | 'powertrain' | 'needs' | 'finance';
type View = { kind: 'loading' } | { kind: 'error'; auth: boolean } | { kind: 'profile' } | { kind: 'intro' } | { kind: 'step'; step: StepId }
  | { kind: 'summary' } | { kind: 'question'; question: MatchQuestion } | { kind: 'results' };
const EMPTY: Answers = { priorities: [], powertrain: 'any', strength: 'soft', needs: [], needsStrength: 'soft' };
const MAX_FOLLOW_UPS = 2;

const TRAVELER_OPTIONS: Array<{ value: typeof TRAVELERS[number]; label: string; icon: ChatIconName }> = [
  { value: 'solo', label: 'בעיקר אני', icon: 'user' }, { value: 'couple', label: 'זוג', icon: 'users' },
  { value: 'small_family', label: 'משפחה קטנה', icon: 'users' }, { value: 'large_family', label: 'משפחה גדולה', icon: 'users' },
  { value: 'varies', label: 'משתנה', icon: 'route' }];
const SEAT_OPTIONS: Array<{ value: typeof SEAT_NEEDS[number]; label: string }> = [
  { value: '2', label: '2' }, { value: '4', label: '4' }, { value: '5', label: '5' }, { value: '7', label: '7+' }, { value: 'any', label: 'לא משנה לי' }];
const PRIORITY_OPTIONS: Array<{ value: Priority; label: string; icon: ChatIconName; hint?: string }> = [
  { value: 'cost', label: 'חיסכון בעלויות', icon: 'wallet', hint: 'לפי אומדן הנטו' }, { value: 'family_space', label: 'מרחב למשפחה', icon: 'users' },
  { value: 'large_trunk', label: 'תא מטען גדול', icon: 'layers' }, { value: 'long_trips', label: 'נוחות לנסיעות ארוכות', icon: 'route' },
  { value: 'city', label: 'קל לתמרון וחניה בעיר', icon: 'car' }, { value: 'technology', label: 'טכנולוגיה ואבזור', icon: 'spark', hint: 'אין נתונים בקטלוג' },
  { value: 'energy', label: 'חיסכון בדלק או בחשמל', icon: 'leaf', hint: 'אין נתוני צריכת דלק בקטלוג' }];
const DRIVING_OPTIONS: Array<{ value: typeof DRIVING[number]; label: string; icon: ChatIconName }> = [
  { value: 'city', label: 'בעיקר בתוך העיר', icon: 'car' }, { value: 'mixed', label: 'עיר ובין־עירוני', icon: 'route' },
  { value: 'long', label: 'בעיקר נסיעות ארוכות', icon: 'forward' }, { value: 'all', label: 'הכול מהכול', icon: 'layers' }];
const DISTANCE_OPTIONS: Array<{ value: typeof DISTANCES[number]; label: string }> = [
  { value: 'low', label: 'עד 1,000 ק״מ' }, { value: 'mid', label: '1,000–2,000 ק״מ' }, { value: 'high', label: 'מעל 2,000 ק״מ' }, { value: 'unsure', label: 'עוד לא ברור' }];
const CHARGING_OPTIONS: Array<{ value: typeof CHARGING[number]; label: string; icon: ChatIconName }> = [
  { value: 'home', label: 'יש טעינה בבית', icon: 'plug' }, { value: 'work', label: 'יש טעינה בעבודה', icon: 'plug' },
  { value: 'public', label: 'גישה לטעינה ציבורית', icon: 'zap' }, { value: 'none', label: 'אין אפשרות טעינה קבועה', icon: 'close' },
  { value: 'unknown', label: 'לא ידוע לי', icon: 'info' }];
const NEED_OPTIONS: Array<{ value: Need; icon: ChatIconName }> = [
  { value: 'seats5', icon: 'users' }, { value: 'seats7', icon: 'users' }, { value: 'large_trunk', icon: 'layers' },
  { value: 'compact', icon: 'car' }, { value: 'high_body', icon: 'car' }];
const FINANCE_OPTIONS: Array<{ value: typeof FINANCE[number]; label: string; hint: string; icon: ChatIconName }> = [
  { value: 'net_first', label: 'הכי חשוב לי לשמור על הנטו', hint: 'אומדן הנטו מקבל משקל כפול', icon: 'wallet' },
  { value: 'balanced', label: 'איזון בין עלות לנוחות', hint: 'משקל רגיל לכל השיקולים', icon: 'layers' },
  { value: 'fit_first', label: 'אפשר להתפשר קצת על הנטו בשביל התאמה טובה יותר', hint: 'ההתאמה לאורח החיים קודמת', icon: 'spark' }];
const STEPS: Array<{ id: StepId; title: string }> = [
  { id: 'travelers', title: 'נוסעים' }, { id: 'priorities', title: 'מה חשוב' }, { id: 'driving', title: 'נסיעות' },
  { id: 'powertrain', title: 'סוג רכב' }, { id: 'needs', title: 'דרישות' }, { id: 'finance', title: 'כלכלה' }];
const labelOf = <T extends string>(options: Array<{ value: T; label?: string }>, value?: T) => options.find(option => option.value === value)?.label;
const FIT_TEXT = { high: 'התאמה גבוהה', good: 'התאמה טובה', partial: 'התאמה חלקית' } as const;

export function toPreferences(answers: Answers): MatchPreferences {
  const value: MatchPreferences = { powertrain: answers.powertrain };
  if (answers.powertrain !== 'any') value.strength = answers.strength;
  if (answers.priority && value.strength === 'soft' && !answers.finance) value.priority = answers.priority;
  if (answers.family) value.family = answers.family;
  if (answers.travelers) value.travelers = answers.travelers;
  if (answers.seats) value.seats = answers.seats;
  if (answers.priorities.length) value.priorities = answers.priorities;
  if (answers.driving) value.driving = answers.driving;
  if (answers.distance) value.distance = answers.distance;
  if (answers.charging) value.charging = answers.charging;
  if (answers.needs.length) { value.needs = answers.needs; value.needsStrength = answers.needsStrength; }
  if (answers.finance) value.finance = answers.finance;
  return value;
}

async function requestMatch(preferences: MatchPreferences, signal: AbortSignal): Promise<MatchResponse> {
  const response = await fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    cache: 'no-store', body: JSON.stringify({ preferences }), signal });
  if (response.status === 401) throw new Error('auth');
  if (!response.ok) throw new Error('unavailable');
  const data = await response.json() as MatchResponse;
  if (data.status !== 'ready' && data.status !== 'needs_profile') throw new Error('unavailable');
  return data;
}

/** A heading that receives focus once when its screen opens (screen readers hear the new step). */
function FocusHeading({ id, children }: { id: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <h2 id={id} ref={heading} tabIndex={-1}>{children}</h2>;
}

function Choice({ label, hint, icon, selected, onSelect, multi = false, disabled = false }: {
  label: string; hint?: string; icon?: ChatIconName; selected: boolean; onSelect: () => void; multi?: boolean; disabled?: boolean;
}) {
  return <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={selected} disabled={disabled}
    className={`cw-match-choice ${selected ? 'cw-match-choice-on' : ''}`} onClick={onSelect}>
    {icon && <span className="cw-match-choice-icon" aria-hidden="true"><ChatIcon name={icon} /></span>}
    <span className="cw-match-choice-text"><strong>{label}</strong>{hint && <span>{hint}</span>}</span>
    <span className="cw-match-choice-check" aria-hidden="true">{selected && <ChatIcon name="check" />}</span>
  </button>;
}
function Group({ label, children, multi = false, compact = false }: { label: string; children: ReactNode; multi?: boolean; compact?: boolean }) {
  const id = useId();
  return <div className="cw-match-group">
    <p className="cw-match-group-label" id={id}>{label}</p>
    <div className={`cw-match-choices ${compact ? 'cw-match-choices-compact' : ''}`} role={multi ? 'group' : 'radiogroup'} aria-labelledby={id}>{children}</div>
  </div>;
}

function StepFrame({ index, title, subtitle, children, onBack, onNext, nextLabel = 'המשך', onSkip }: {
  index: number; title: string; subtitle?: string; children: ReactNode; onBack: () => void; onNext: () => void; nextLabel?: string; onSkip?: () => void;
}) {
  return <section className="cw-match-question cw-match-enter" aria-labelledby="cw-match-step-title">
    <div className="cw-match-progress">
      <ol aria-label={`שלב ${index + 1} מתוך ${STEPS.length}`}>{STEPS.map((step, position) => <li key={step.id}
        className={position < index ? 'cw-done' : position === index ? 'cw-current' : ''} aria-current={position === index ? 'step' : undefined}>
        <span className="cw-match-progress-dot" aria-hidden="true" /><span>{step.title}</span></li>)}</ol>
      <p className="cw-match-step">שלב {index + 1} מתוך {STEPS.length}</p>
    </div>
    <FocusHeading key={title} id="cw-match-step-title">{title}</FocusHeading>
    {subtitle && <p className="cw-match-explain">{subtitle}</p>}
    {children}
    <div className="cw-match-nav-row">
      <button type="button" className="cw-match-back" onClick={onBack}><ChatIcon name="forward" />חזרה</button>
      <div>
        {onSkip && <button type="button" className="cw-match-skip" onClick={onSkip}>דילוג</button>}
        <button type="button" className="cw-showroom-primary cw-match-next" onClick={onNext}>{nextLabel}<ChatIcon name="forward" /></button>
      </div>
    </div>
  </section>;
}

function Financial({ item }: { item: MatchRecommendation }) {
  const financial = item.financial;
  if (financial.status === 'unavailable') return <div className="cw-match-money cw-match-money-off">
    <span className="cw-match-money-label"><ChatIcon name="info" />השפעה משוערת על הנטו: לא זמינה</span>
    <p>{financial.reason}</p>
  </div>;
  const sign = financial.delta > 0 ? '+' : financial.delta < 0 ? '−' : '';
  return <div className={`cw-match-money ${financial.delta < 0 ? 'cw-match-money-down' : ''}`}>
    <span className="cw-match-money-label"><ChatIcon name="calculator" />השפעה משוערת על הנטו · אומדן זמני</span>
    <strong dir="ltr">{sign}{Math.abs(financial.delta).toLocaleString('he-IL')} ₪</strong>
    <p>בחודש, לעומת המצב שלך היום. לא סופי ואינו תלוש שכר.</p>
  </div>;
}

const CARD_LABEL = { top: 'ההתאמה המובילה', value: 'אלטרנטיבה משתלמת', more: 'אפשרות נוספת' } as const;
const unknownText = 'אין נתון';
function chargingNeed(item: MatchRecommendation) {
  if (POWERTRAIN_UNDER_REVIEW[item.vehicle.id]) return 'אין נתון (סיווג ההנעה בבדיקה)';
  return item.vehicle.drive_type === 'חשמלי' ? 'נדרשת טעינה' : item.vehicle.drive_type === 'פלאג-אין' ? 'מומלצת טעינה' : 'לא נדרשת טעינה';
}
function specRows(item: MatchRecommendation) {
  const profile = item.profile;
  return [
    { label: 'סוג מרכב*', value: profile.bodyType ? BODY_LABEL[profile.bodyType] : unknownText },
    { label: 'מקומות ישיבה*', value: profile.seats ? String(profile.seats) : unknownText },
    { label: 'תא מטען*', value: profile.trunkLiters ? `כ־${profile.trunkLiters} ליטר` : unknownText },
    { label: 'טווח חשמלי*', value: profile.rangeKm ? `${profile.rangeKm.min === profile.rangeKm.max ? profile.rangeKm.min : `${profile.rangeKm.min}–${profile.rangeKm.max}`} ק״מ (כללי לגרסאות)`
      : item.vehicle.drive_type === 'חשמלי' ? unknownText : 'לא רלוונטי' }
  ];
}

function RecommendationCard({ item, onCompare }: { item: MatchRecommendation; onCompare?: () => void }) {
  const titleId = useId();
  const drive = propulsion(item.vehicle.drive_type);
  const vehicle = item.vehicle;
  const rankText = item.rank === 1 && item.label !== 'top' ? 'המלצה 1' : CARD_LABEL[item.label];
  return <article className={`cw-match-card ${item.rank === 1 ? 'cw-match-card-first' : ''}`} aria-labelledby={titleId}>
    <div className="cw-vehicle-media">
      <VehiclePhoto vehicle={vehicle} sizes="(max-width: 800px) 100vw, 33vw" priority={item.rank === 1} />
      <div className="cw-vehicle-badges">
        <span className="cw-badge cw-match-rank">{rankText}</span>
        <span className={`cw-badge ${vehicle.group_code === FAMILY_GROUP ? 'cw-badge-family' : ''}`}>{groupLabel(vehicle.group_code)}</span>
      </div>
      <span className="cw-match-illustration">הדמיית AI להמחשה בלבד</span>
    </div>
    <div className="cw-match-body">
      <div className="cw-match-heading">
        <div><h3 id={titleId}><bdi dir="ltr">{vehicle.display_name}</bdi>{vehicle.registration_year ? <span className="cw-match-year"> {vehicle.registration_year}</span> : null}</h3>
          <p>{vehicle.manufacturer_name}</p></div>
        <p className="cw-eligibility cw-eligibility-eligible"><ChatIcon name="check" /><span>כלול בזכאות שלך</span></p>
      </div>
      <div className="cw-match-meta">
        <span className={`cw-match-drive cw-badge-${drive.icon}`}><ChatIcon name={drive.icon} />{drive.tile}</span>
        <span className={`cw-match-fit ${item.fitLabel ? `cw-match-fit-${item.fitLabel}` : 'cw-match-fit-none'}`}>
          {item.fitLabel ? FIT_TEXT[item.fitLabel] : 'אין מספיק נתונים לרמת התאמה'}</span>
        {item.evidence.total > 1 && <span className="cw-match-evidence">נבדקו {item.evidence.known} מתוך {item.evidence.total} שיקולים שבחרת</span>}
      </div>
      <Financial item={item} />
      <div className="cw-match-lists">
        <div><h4>למה הרכב הזה מתאים לך?</h4><ul>{item.reasons.map(text => <li key={text}><ChatIcon name="check" />{text}</li>)}</ul></div>
        {(item.tradeoffs.length > 0 || item.missing.length > 0) && <div><h4>מה כדאי לקחת בחשבון?</h4>
          {item.tradeoffs.length > 0 && <ul className="cw-match-tradeoffs">{item.tradeoffs.map(text => <li key={text}><ChatIcon name="info" />{text}</li>)}</ul>}
          {item.missing.length > 0 && <ul className="cw-match-missing">{item.missing.map(text => <li key={text}><ChatIcon name="alert" />{text}</li>)}</ul>}
        </div>}
      </div>
      <details className="cw-match-details">
        <summary><ChatIcon name="info" />פרטי הרכב</summary>
        <dl>{[{ label: 'הנעה (קטלוג החברה)', value: drive.tile }, { label: 'קבוצה (קטלוג החברה)', value: groupLabel(vehicle.group_code) },
          { label: 'שנת רישום (קטלוג החברה)', value: vehicle.registration_year ? String(vehicle.registration_year) : unknownText },
          { label: 'טעינה', value: chargingNeed(item) }, ...specRows(item)].map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
        <p>* לפי מאפייני הדגם הכלליים. לא אומת לגרסה המדויקת שבקטלוג.</p>
      </details>
      <div className="cw-match-card-actions">
        <Link href={netImpactHref(vehicle.id)} className="cw-showroom-primary"><ChatIcon name="chat" /><span>המשך בצ׳אט</span></Link>
        {onCompare && <button type="button" className="cw-showroom-ghost" onClick={onCompare}><ChatIcon name="compare" /><span>השוואה</span></button>}
      </div>
    </div>
  </article>;
}

function Comparison({ items }: { items: MatchRecommendation[] }) {
  const rows: Array<{ label: string; value: (item: MatchRecommendation) => string }> = [
    { label: 'רמת התאמה', value: item => item.fitLabel ? FIT_TEXT[item.fitLabel] : 'אין מספיק נתונים' },
    { label: 'הנעה', value: item => propulsion(item.vehicle.drive_type).tile },
    { label: 'קבוצה', value: item => groupLabel(item.vehicle.group_code) },
    ...['סוג מרכב*', 'מקומות ישיבה*', 'תא מטען*', 'טווח חשמלי*'].map(label => ({ label, value: (item: MatchRecommendation) => specRows(item).find(row => row.label === label)!.value })),
    { label: 'טעינה', value: chargingNeed },
    { label: 'אומדן השפעה על הנטו', value: item => item.financial.status === 'estimate'
      ? `${item.financial.delta > 0 ? '+' : item.financial.delta < 0 ? '−' : ''}${Math.abs(item.financial.delta).toLocaleString('he-IL')} ₪ בחודש` : 'לא זמין' },
    { label: 'למה מתאים לך', value: item => item.reasons[0] ?? unknownText }
  ];
  return <section className="cw-match-compare cw-match-enter" id="cw-match-compare" aria-labelledby="cw-match-compare-title" tabIndex={-1}>
    <h3 id="cw-match-compare-title"><ChatIcon name="compare" />השוואת הרכבים שהומלצו</h3>
    <div className="cw-match-compare-scroll" role="region" aria-labelledby="cw-match-compare-title" tabIndex={0}>
      <table>
        <thead><tr><th scope="col"><span className="cw-sr-only">מאפיין</span></th>{items.map(item => <th key={item.vehicle.id} scope="col"><bdi dir="ltr">{item.vehicle.display_name}</bdi></th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{items.map(item => {
          const value = row.value(item);
          return <td key={item.vehicle.id} className={value.startsWith(unknownText) ? 'cw-match-unknown' : undefined}>{value}</td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    <p className="cw-match-footnote">* לפי מאפייני הדגם הכלליים (טיוטת מחקר), לא מאומת לגרסה המדויקת. הנעה, קבוצה ואומדן הנטו — מקטלוג החברה וממחשבון החברה.</p>
  </section>;
}

function summaryRows(answers: Answers, powertrains: MatchPowertrain[]): Array<{ step: StepId; label: string; value: string; empty: boolean }> {
  const row = (step: StepId, label: string, value: string | undefined, fallback = 'דילגת') => ({ step, label, value: value || fallback, empty: !value });
  return [
    row('travelers', 'מי נוסע', [labelOf(TRAVELER_OPTIONS, answers.travelers), answers.seats && answers.seats !== 'any' ? `${labelOf(SEAT_OPTIONS, answers.seats)} מקומות` : ''].filter(Boolean).join(' · ')),
    row('priorities', 'מה חשוב', answers.priorities.map(value => labelOf(PRIORITY_OPTIONS, value)).join(' · ')),
    row('driving', 'נסיעות', [labelOf(DRIVING_OPTIONS, answers.driving), labelOf(DISTANCE_OPTIONS, answers.distance)].filter(Boolean).join(' · ')),
    row('powertrain', 'סוג רכב', [answers.powertrain === 'any' ? 'פתוח לכל סוג' : `${powertrainLabel(answers.powertrain)} (${answers.strength === 'hard' ? 'חובה' : 'העדפה'})`,
      powertrains.some(value => value === 'חשמלי' || value === 'פלאג-אין') ? labelOf(CHARGING_OPTIONS, answers.charging) : ''].filter(Boolean).join(' · ')),
    row('needs', 'דרישות', answers.needs.length ? `${answers.needs.map(need => NEED_LABEL[need]).join(' · ')} (${answers.needsStrength === 'hard' ? 'חובה' : 'העדפה'})` : undefined, 'אין דרישה מיוחדת'),
    row('finance', 'כלכלה', labelOf(FINANCE_OPTIONS, answers.finance))
  ];
}

function Results({ data, answers, onEdit, onRestart }: { data: Ready; answers: Answers; onEdit: () => void; onRestart: () => void }) {
  const [compareOpen, setCompareOpen] = useState(false);
  const openCompare = () => { setCompareOpen(true); requestAnimationFrame(() => document.getElementById('cw-match-compare')?.focus()); };
  const { outcome } = data;
  const items = outcome.recommendations;
  const ids = items.map(item => item.vehicle.id);
  const chips = summaryRows(answers, data.powertrains).filter(row => !row.empty);
  const chatHref = ids.length > 1 ? `/employee?${new URLSearchParams({ compare: ids.join(',') })}` : ids.length ? netImpactHref(ids[0]) : '/employee';
  return <section className="cw-match-results cw-match-enter" aria-labelledby="cw-match-results-title">
    <header className="cw-match-report-head">
      <p className="cw-match-step">הדוח האישי שלך</p>
      <FocusHeading id="cw-match-results-title">{items.length ? 'מצאנו את הרכבים שהכי מתאימים לך' : 'לא מצאנו רכב שעומד בכל הדרישות'}</FocusHeading>
      <p className="cw-match-explain">בדקנו את ההעדפות שלך מול הרכבים שכלולים בזכאות שלך · {data.basis.occupation} · {groupLabel(data.basis.group)}</p>
      {chips.length > 0 && <ul className="cw-match-chips" aria-label="ההעדפות שלך">{chips.map(row => <li key={row.step}><strong>{row.label}:</strong> {row.value}</li>)}</ul>}
    </header>
    {outcome.empty && <div className="cw-match-empty" role="status"><ChatIcon name="info" /><p>{outcome.empty}</p>
      <button type="button" className="cw-showroom-primary" onClick={onEdit}>שינוי ההעדפות</button></div>}
    {items.length > 0 && <div className="cw-match-grid">{items.map(item => <RecommendationCard key={item.vehicle.id} item={item}
      onCompare={items.length > 1 ? openCompare : undefined} />)}</div>}
    {items.length > 1 && compareOpen && <Comparison items={items} />}
    <div className="cw-match-bottom-actions">
      <button type="button" className="cw-showroom-ghost" onClick={onEdit}><ChatIcon name="reset" /><span>שינוי העדפות</span></button>
      {items.length > 1 && <button type="button" className="cw-showroom-ghost" aria-expanded={compareOpen} aria-controls="cw-match-compare"
        onClick={() => compareOpen ? setCompareOpen(false) : openCompare()}>
        <ChatIcon name="compare" /><span>{compareOpen ? 'הסתרת ההשוואה' : 'השוואת הרכבים'}</span></button>}
      <Link className="cw-showroom-secondary" href={chatHref}><ChatIcon name="chat" /><span>התייעצות עם CarWise בצ׳אט</span></Link>
      <button type="button" className="cw-match-skip" onClick={onRestart}>להתחיל מחדש</button>
    </div>
    <aside className="cw-match-notes" aria-labelledby="cw-match-how">
      <h3 id="cw-match-how"><ChatIcon name="shield" />איך בחרנו עבורך?</h3>
      <ol className="cw-match-how-steps">
        <li><strong>זכאות קודם לכל.</strong> רק רכבים פעילים בקטלוג החברה שכלולים בזכאות שלך לפי כללי החברה והפרופיל המאושר.</li>
        <li><strong>דרישות החובה שלך.</strong> רכב שהמידע עליו סותר דרישת חובה לא הוצג; דרישה שאין עליה נתון מסומנת לבדיקה.</li>
        <li><strong>ההעדפות שלך.</strong> כל שיקול שבחרת נבדק מול מאפייני הדגם הכלליים, עם משקל גבוה יותר למה שסימנת כחשוב. שיקול בלי נתון לא נספר לטובה וגם לא לרעה.</li>
        <li><strong>אומדן הנטו.</strong> מחושב רק במחשבון החברה הקיים, לפי הפרופיל המאושר שלך.</li>
      </ol>
      <p className="cw-match-how-note">הדירוג נעשה בכללים קבועים ושקופים, בלי ציון באחוזים ובלי שמודל AI מנתח או ממציא נתונים. אותן תשובות תמיד יניבו אותן המלצות.</p>
      <ul>
        {outcome.excluded.current > 0 && <li>הרכב שיש לך היום לא מוצג כהמלצה.</li>}
        {outcome.excluded.requirement > 0 && <li>{outcome.excluded.requirement === 1 ? 'רכב אחד לא הוצג' : `${outcome.excluded.requirement} רכבים לא הוצגו`} כי לפי המידע הכללי על הדגם הם לא עומדים בדרישת חובה שלך.</li>}
        {outcome.excluded.underReview > 0 && <li>רכב שסיווג ההנעה שלו בבדיקה לא נחשב כמתאים להעדפת ההנעה.</li>}
        <li>מאפייני הרכבים (מרכב, מושבים, תא מטען, אופי שימוש) הם מידע כללי על הדגם ולא אומתו לגרסה המדויקת. אין בקטלוג נתוני בטיחות, צריכת דלק או אבזור.</li>
        {outcome.unsupported.map(note => <li key={note}>{note}</li>)}
        {data.notes.map(note => <li key={note}>{note}</li>)}
      </ul>
    </aside>
  </section>;
}

export function MatchApp({ userId, account }: { userId: string; account?: EmployeeAccount }) {
  const router = useRouter();
  const list = useConversationList();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [data, setData] = useState<Ready | null>(null);
  const [reason, setReason] = useState('');
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [followUps, setFollowUps] = useState(0);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const controller = useRef<AbortController | null>(null);

  /** Only the latest request may update the screen; an older, slower answer is ignored. */
  const run = useCallback(async (next: Answers, asked: number, opening = false) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    const timeout = setTimeout(() => current.abort(), 20000);
    setView({ kind: 'loading' });
    try {
      const result = await requestMatch(opening ? { powertrain: 'any' } : toPreferences(next), current.signal);
      if (controller.current !== current) return;
      if (result.status === 'needs_profile') { setReason(result.reason); setView({ kind: 'profile' }); return; }
      setData(result);
      if (opening) { setView({ kind: 'intro' }); return; }
      if (result.question && asked < MAX_FOLLOW_UPS) { setFollowUps(asked + 1); setView({ kind: 'question', question: result.question }); return; }
      setView({ kind: 'results' });
    } catch (error) {
      if (controller.current !== current) return;
      setRetry(() => () => void run(next, asked, opening));
      setView({ kind: 'error', auth: error instanceof Error && error.message === 'auth' });
    } finally { clearTimeout(timeout); }
  }, []);
  useEffect(() => { void run(EMPTY, 0, true); return () => controller.current?.abort(); }, [run]);

  const update = (patch: Partial<Answers>) => setAnswers(current => ({ ...current, ...patch }));
  const powertrains = data?.powertrains ?? [];
  const charges = powertrains.some(value => value === 'חשמלי' || value === 'פלאג-אין');
  const go = (step: StepId) => setView({ kind: 'step', step });
  const order = STEPS.map(step => step.id);
  const next = (step: StepId) => { const index = order.indexOf(step); if (editing || index === order.length - 1) { setEditing(false); setView({ kind: 'summary' }); } else go(order[index + 1]); };
  const back = (step: StepId) => { const index = order.indexOf(step); if (editing) { setEditing(false); setView({ kind: 'summary' }); } else if (index === 0) setView({ kind: 'intro' }); else go(order[index - 1]); };
  // A new search starts its clarifications afresh; earlier follow-up answers are not reused silently.
  const submit = () => { const fresh = { ...answers, family: undefined, priority: undefined }; setAnswers(fresh); void run(fresh, 0); };
  const answerFollowUp = (patch: Partial<Answers>) => { const value = { ...answers, ...patch }; setAnswers(value); void run(value, followUps); };
  const openConversation = (id: string | null) => { rememberActiveConversation(userId, id); router.push(id ? `/employee?${new URLSearchParams({ conversation: id })}` : '/employee'); };

  let content: ReactNode = null;
  if (view.kind === 'loading') content = <div className="cw-match-loading" role="status"><CarWiseCarLoader label="בודקים את הרכבים שכלולים בזכאות שלך…" /></div>;
  else if (view.kind === 'error') content = <div className="cw-match-empty" role="alert"><ChatIcon name="alert" />
    <p>{view.auth ? 'כדי להמשיך צריך להתחבר שוב.' : 'לא הצלחנו לטעון את ההתאמה כרגע. התשובות שלך נשמרו בדף, ואפשר לנסות שוב.'}</p>
    {view.auth ? <Link className="cw-showroom-primary" href="/login">להתחברות</Link>
      : <button type="button" className="cw-showroom-primary" onClick={() => retry?.()}><ChatIcon name="retry" />ניסיון חוזר</button>}
  </div>;
  else if (view.kind === 'profile') content = <div className="cw-match-empty cw-match-profile" role="status"><ChatIcon name="shield" />
    <div><strong>קודם מאשרים את הפרטים</strong><p>{reason}</p></div>
    <Link className="cw-showroom-primary" href="/employee"><ChatIcon name="chat" /><span>לאישור הפרטים בשיחה</span></Link>
  </div>;
  else if (view.kind === 'intro' && data) content = <section className="cw-match-hero cw-match-enter" aria-labelledby="cw-match-hero-title">
    <span className="cw-match-hero-mark" aria-hidden="true"><ChatIcon name="spark" /></span>
    <p className="cw-match-step">CarWise Match</p>
    <FocusHeading id="cw-match-hero-title">בואו נמצא את הרכב שמתאים בדיוק לך</FocusHeading>
    <p className="cw-match-hero-lead">עונים על כמה שאלות קצרות, ו־CarWise בודק אילו מהרכבים שכלולים בזכאות שלך הכי מתאימים לאורח החיים ולהעדפות שלך.</p>
    <ol className="cw-match-hero-steps">
      <li><ChatIcon name="clock" /><span><strong>6 שאלות קצרות</strong>כ־2 דקות, ואפשר לדלג</span></li>
      <li><ChatIcon name="shield" /><span><strong>רק רכבים שכלולים בזכאות</strong>{data.basis.occupation} · {groupLabel(data.basis.group)}</span></li>
      <li><ChatIcon name="calculator" /><span><strong>עד 3 המלצות עם הסבר</strong>ואומדן נטו ממחשבון החברה</span></li>
    </ol>
    <button type="button" className="cw-showroom-primary cw-match-cta" onClick={() => { setEditing(false); go('travelers'); }}>בואו נמצא לי רכב<ChatIcon name="forward" /></button>
  </section>;
  else if (view.kind === 'step') {
    const index = order.indexOf(view.step);
    const common = { index, onBack: () => back(view.step), onNext: () => next(view.step) };
    if (view.step === 'travelers') content = <StepFrame {...common} title="מי בדרך כלל נוסע איתך?" onSkip={() => { update({ travelers: undefined, seats: undefined }); next('travelers'); }}>
      <Group label="נוסעים">{TRAVELER_OPTIONS.map(option => <Choice key={option.value} label={option.label} icon={option.icon}
        selected={answers.travelers === option.value} onSelect={() => update({ travelers: answers.travelers === option.value ? undefined : option.value })} />)}</Group>
      <Group label="כמה מקומות ישיבה צריכים להיות ברכב? (לא חובה)" compact>{SEAT_OPTIONS.map(option => <Choice key={option.value} label={option.label}
        selected={answers.seats === option.value} onSelect={() => update({ seats: answers.seats === option.value ? undefined : option.value })} />)}</Group>
    </StepFrame>;
    else if (view.step === 'priorities') content = <StepFrame {...common} title="מה הכי חשוב לך ברכב?" subtitle={`אפשר לבחור עד 3 · נבחרו ${answers.priorities.length} מתוך 3`}
      onSkip={() => { update({ priorities: [] }); next('priorities'); }}>
      <Group label="סדרי עדיפויות" multi>{PRIORITY_OPTIONS.map(option => {
        const selected = answers.priorities.includes(option.value);
        return <Choice key={option.value} multi label={option.label} hint={option.hint} icon={option.icon} selected={selected}
          disabled={!selected && answers.priorities.length >= 3}
          onSelect={() => update({ priorities: selected ? answers.priorities.filter(value => value !== option.value) : [...answers.priorities, option.value] })} />;
      })}</Group>
    </StepFrame>;
    else if (view.step === 'driving') content = <StepFrame {...common} title="איך נראות הנסיעות שלך?" onSkip={() => { update({ driving: undefined, distance: undefined }); next('driving'); }}>
      <Group label="דפוס הנסיעה העיקרי">{DRIVING_OPTIONS.map(option => <Choice key={option.value} label={option.label} icon={option.icon}
        selected={answers.driving === option.value} onSelect={() => update({ driving: answers.driving === option.value ? undefined : option.value })} />)}</Group>
      <Group label="מרחק חודשי משוער" compact>{DISTANCE_OPTIONS.map(option => <Choice key={option.value} label={option.label}
        selected={answers.distance === option.value} onSelect={() => update({ distance: answers.distance === option.value ? undefined : option.value })} />)}</Group>
    </StepFrame>;
    else if (view.step === 'powertrain') content = <StepFrame {...common} title="איזה סוג רכב מתאים לך?"
      subtitle={charges ? 'מוצגים רק סוגי הנעה שקיימים ברכבים שכלולים בזכאות שלך.' : 'אין ברכבים שבזכאות שלך רכב נטען, ולכן לא נשאל על טעינה.'}>
      {charges && <Group label="אפשרויות טעינה">{CHARGING_OPTIONS.map(option => <Choice key={option.value} label={option.label} icon={option.icon}
        selected={answers.charging === option.value} onSelect={() => update({ charging: answers.charging === option.value ? undefined : option.value })} />)}</Group>}
      <Group label="הנעה מועדפת">
        <Choice label="פתוח לכל סוג" icon="spark" selected={answers.powertrain === 'any'} onSelect={() => update({ powertrain: 'any' })} />
        {powertrains.map(value => <Choice key={value} label={propulsion(value).tile} icon={propulsion(value).icon}
          hint={value === 'פלאג-אין' ? 'רכב שסיווג ההנעה שלו בבדיקה לא ייחשב כמתאים' : undefined}
          selected={answers.powertrain === value} onSelect={() => update({ powertrain: value })} />)}
      </Group>
      {answers.powertrain !== 'any' && <Group label="עד כמה זה חשוב?" compact>
        <Choice label="חובה מבחינתי" selected={answers.strength === 'hard'} onSelect={() => update({ strength: 'hard' })} />
        <Choice label="רק העדפה" selected={answers.strength === 'soft'} onSelect={() => update({ strength: 'soft' })} />
      </Group>}
    </StepFrame>;
    else if (view.step === 'needs') content = <StepFrame {...common} title="יש משהו שחייב להיות ברכב?"
      subtitle="הנתונים על מושבים, תא מטען וגודל הם מידע כללי על הדגם. דרישת חובה שאין עליה נתון תסומן לבדיקה ולא תוצג כמאומתת.">
      <Group label="דרישות" multi>
        {NEED_OPTIONS.map(option => { const selected = answers.needs.includes(option.value);
          return <Choice key={option.value} multi label={NEED_LABEL[option.value]} icon={option.icon} selected={selected}
            onSelect={() => update({ needs: selected ? answers.needs.filter(value => value !== option.value)
              : [...answers.needs.filter(value => !(option.value === 'seats7' && value === 'seats5') && !(option.value === 'seats5' && value === 'seats7')), option.value] })} />; })}
        <Choice multi label="אין דרישה מיוחדת" icon="check" selected={!answers.needs.length} onSelect={() => update({ needs: [] })} />
      </Group>
      {answers.needs.length > 0 && <Group label="האם אלה דרישות חובה?" compact>
        <Choice label="חובה" hint="רכב שסותר אותן לא יוצג" selected={answers.needsStrength === 'hard'} onSelect={() => update({ needsStrength: 'hard' })} />
        <Choice label="העדפה" hint="ישפיעו על הדירוג בלבד" selected={answers.needsStrength === 'soft'} onSelect={() => update({ needsStrength: 'soft' })} />
      </Group>}
    </StepFrame>;
    else content = <StepFrame {...common} title="כמה חשוב לך ההיבט הכלכלי?" subtitle="האומדן מחושב במחשבון החברה הקיים בלבד." nextLabel="לסיכום"
      onSkip={() => { update({ finance: undefined }); next('finance'); }}>
      <Group label="היבט כלכלי">{FINANCE_OPTIONS.map(option => <Choice key={option.value} label={option.label} hint={option.hint} icon={option.icon}
        selected={answers.finance === option.value} onSelect={() => update({ finance: answers.finance === option.value ? undefined : option.value })} />)}</Group>
    </StepFrame>;
  } else if (view.kind === 'summary') content = <section className="cw-match-question cw-match-enter" aria-labelledby="cw-match-summary-title">
    <p className="cw-match-step">סיכום</p>
    <FocusHeading id="cw-match-summary-title">זה מה שהבנתי עליך</FocusHeading>
    <p className="cw-match-explain">אפשר לערוך כל שורה לפני שמחפשים.</p>
    <ul className="cw-match-summary">{summaryRows(answers, powertrains).map(row => <li key={row.step}>
      <span><strong>{row.label}</strong>{row.value}</span>
      <button type="button" className="cw-match-edit" onClick={() => { setEditing(true); go(row.step); }} aria-label={`עריכת ${row.label}`}><ChatIcon name="reset" />עריכה</button>
    </li>)}</ul>
    <div className="cw-match-nav-row">
      <button type="button" className="cw-match-back" onClick={() => go('finance')}><ChatIcon name="forward" />חזרה</button>
      <button type="button" className="cw-showroom-primary cw-match-next" onClick={submit}>מצאו לי את הרכב המתאים<ChatIcon name="spark" /></button>
    </div>
  </section>;
  else if (view.kind === 'question' && view.question === 'family') content = <section className="cw-match-question cw-match-enter" aria-labelledby="cw-match-follow">
    <p className="cw-match-step">שאלת הבהרה · התשובה משנה את ההמלצות</p>
    <FocusHeading id="cw-match-follow">לכלול את רכבי המסלול המשפחתי?</FocusHeading>
    <p className="cw-match-explain">לפי הפרופיל המאושר יש זכאות למסלול המשפחתי (לפי כללי החברה, לא לפי התשובות בשאלון).</p>
    <Group label="מסלול משפחתי">
      <Choice label="כן, לכלול" icon="users" selected={false} onSelect={() => answerFollowUp({ family: 'include' })} />
      <Choice label="רק רכבי הקבוצה הרגילה" icon="layers" selected={false} onSelect={() => answerFollowUp({ family: 'exclude' })} />
    </Group>
  </section>;
  else if (view.kind === 'question' && view.question === 'priority' && answers.powertrain !== 'any') content = <section className="cw-match-question cw-match-enter" aria-labelledby="cw-match-follow">
    <p className="cw-match-step">שאלת הבהרה · התשובה משנה את ההמלצות</p>
    <FocusHeading id="cw-match-follow">מה חשוב לך יותר?</FocusHeading>
    <Group label="עדיפות">
      <Choice label="אומדן נטו טוב יותר" icon="wallet" selected={false} onSelect={() => answerFollowUp({ priority: 'net' })} />
      <Choice label={`ההנעה ${powertrainLabel(answers.powertrain)}`} icon={propulsion(answers.powertrain).icon} selected={false}
        onSelect={() => answerFollowUp({ priority: 'powertrain' })} />
    </Group>
  </section>;
  else if (view.kind === 'results' && data) content = <Results data={data} answers={answers}
    onEdit={() => setView({ kind: 'summary' })} onRestart={() => { setAnswers(EMPTY); setView({ kind: 'intro' }); }} />;

  return <main className="cw-app cw-catalog-app cw-match-app" dir="rtl">
    <a href="#cw-match-main" className="cw-skip-link">מעבר להתאמה</a>
    <ChatSidebar conversations={list.conversations} titles={{}} activeId={null} section="match" account={account}
      open={sidebarOpen} onClose={closeSidebar} locked={false} loading={list.loading} error={list.error} hasMore={Boolean(list.cursor)}
      onLoadMore={() => void list.load(list.cursor)} onRetry={() => void list.load()} onSelect={id => { closeSidebar(); openConversation(id); }} />
    <div className="cw-workspace" inert={sidebarOpen || undefined}>
      <header className="cw-topbar">
        <div className="cw-topbar-title">
          <button className="cw-icon-button cw-menu-toggle" aria-label="פתיחת התפריט" aria-expanded={sidebarOpen} aria-controls="cw-sidebar" onClick={() => setSidebarOpen(true)}><ChatIcon name="menu" /></button>
          <span className="cw-topbar-symbol"><ChatIcon name="spark" /></span>
          <div><strong>CarWise Match</strong><span>{account ? `${account.firstName}, רכב שמתאים לך מתוך הזכאות שלך` : 'רכב שמתאים לך מתוך הזכאות שלך'}</span></div>
        </div>
        <Link href="/catalog" className="cw-showroom-back"><ChatIcon name="car" /><span>לקטלוג</span></Link>
      </header>
      <div id="cw-match-main" className="cw-showroom-scroll cw-match-scroll" tabIndex={-1}>
        <div className="cw-match-inner" aria-busy={view.kind === 'loading'}>{content}</div>
      </div>
    </div>
  </main>;
}
