'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  EMPTY_FILTERS, FAMILY_GROUP, eligibilityLabel, filterOptions, filterVehicles, filtersActive, groupLabel, netImpactHref, propulsion,
  type ShowroomEligibility, type ShowroomFilters, type ShowroomVehicle
} from '../../lib/catalog/showroom';
import { vehiclePhoto } from '../../lib/catalog/vehicle-media';
import type { Showroom } from '../../lib/catalog/showroom-service';
import { ChatIcon, type ChatIconName } from '../chat/chat-icon';
import { VehiclePhoto } from './vehicle-photo';
import { VehicleImageViewer } from './vehicle-image-viewer';

const UNKNOWN: ShowroomEligibility = { status: 'unknown', reason: 'אין מידע על הזכאות לרכב הזה.' };
const CARD_SIZES = '(max-width: 800px) 100vw, (max-width: 1280px) 50vw, 33vw';

export function CatalogBrowser({ showroom, aliases, onRetry }: { showroom: Showroom; aliases: Record<string, string[]>; onRetry: () => void }) {
  const [filters, setFilters] = useState<ShowroomFilters>(EMPTY_FILTERS);
  const [open, setOpen] = useState<ShowroomVehicle | null>(null);
  const vehicles = useMemo(() => showroom.status === 'ready' ? showroom.vehicles : [], [showroom]);
  const eligibilityOf = (id: string) => showroom.status === 'ready' ? showroom.eligibility[id] ?? UNKNOWN : UNKNOWN;
  const shown = filterVehicles(vehicles, filters, eligibilityOf, vehicle => aliases[vehicle.id] ?? []);
  const options = useMemo(() => filterOptions(vehicles), [vehicles]);

  if (showroom.status === 'unavailable') {
    return <section className="cw-showroom-state" role="alert">
      <span className="cw-showroom-state-icon"><ChatIcon name="alert" /></span>
      <h1>לא הצלחתי לטעון כרגע את קטלוג הרכבים</h1>
      <p>הקטלוג נטען ישירות ממערכות החברה. אפשר לנסות שוב בעוד רגע.</p>
      <button type="button" className="cw-showroom-primary" onClick={onRetry}><ChatIcon name="retry" />ניסיון חוזר</button>
    </section>;
  }

  const basis = showroom.basis;
  const eligibleCount = vehicles.filter(vehicle => eligibilityOf(vehicle.id).status === 'eligible').length;
  const electricCount = vehicles.filter(vehicle => vehicle.drive_type === 'חשמלי').length;
  const set = (patch: Partial<ShowroomFilters>) => setFilters(current => ({ ...current, ...patch }));

  return <div className="cw-showroom">
    <section className="cw-showroom-hero" aria-labelledby="cw-showroom-title">
      <p className="cw-showroom-eyebrow"><ChatIcon name="spark" />קטלוג רכבי החברה</p>
      <h1 id="cw-showroom-title">מגלים את הרכב הבא שלך.</h1>
      <p className="cw-showroom-lead">כל רכבי החברה במקום אחד: תמונות, פרטים וזכאות אישית.</p>
      <ul className="cw-showroom-stats">
        <li><strong>{vehicles.length}</strong><span>רכבים פעילים בקטלוג</span></li>
        {electricCount > 0 && <li><strong>{electricCount}</strong><span>חשמליים</span></li>}
        {basis.kind === 'confirmed'
          ? <li className="cw-showroom-stat-accent"><strong>{eligibleCount}</strong><span>כלולים בזכאות שלך · {groupLabel(basis.group)}</span></li>
          : <li className="cw-showroom-stat-muted"><ChatIcon name="info" /><span>{basis.reason}</span></li>}
      </ul>
    </section>

    <section className="cw-showroom-toolbar" aria-label="חיפוש וסינון">
      <label className="cw-showroom-search">
        <ChatIcon name="search" />
        <span className="cw-visually-hidden">חיפוש רכב</span>
        <input type="search" dir="auto" value={filters.query} onChange={event => set({ query: event.target.value })}
          placeholder="חיפוש לפי דגם או יצרן, למשל טוסון או Model 3" autoComplete="off" />
      </label>
      <ChipGroup label="קבוצה" value={filters.group} onChange={group => set({ group })}
        options={[{ value: 'all', label: 'הכול' }, ...options.groups.map(group => ({ value: group, label: group === FAMILY_GROUP ? 'משפחתי' : group, icon: group === FAMILY_GROUP ? 'users' as const : undefined }))]} />
      <ChipGroup label="הנעה" value={filters.propulsion} onChange={value => set({ propulsion: value })}
        options={[{ value: 'all', label: 'הכול' }, ...options.propulsions.map(value => ({ value, label: propulsion(value).tile, icon: propulsion(value).icon }))]} />
      <div className="cw-showroom-toolbar-end">
        <label className={`cw-showroom-switch ${basis.kind !== 'confirmed' ? 'cw-showroom-switch-disabled' : ''}`}>
          <input type="checkbox" role="switch" checked={filters.eligibleOnly} disabled={basis.kind !== 'confirmed'}
            onChange={event => set({ eligibleOnly: event.target.checked })} />
          <span className="cw-showroom-switch-track" aria-hidden="true"><i /></span>
          <span>רק רכבים בזכאות שלי</span>
        </label>
        {filtersActive(filters) && <button type="button" className="cw-showroom-reset" onClick={() => setFilters(EMPTY_FILTERS)}><ChatIcon name="reset" />איפוס סינון</button>}
      </div>
    </section>

    <p className="cw-showroom-count" aria-live="polite">
      {shown.length === vehicles.length ? `מוצגים כל ${vehicles.length} הרכבים` : `מוצגים ${shown.length} מתוך ${vehicles.length} רכבים`}
    </p>

    {shown.length ? <ul className="cw-showroom-grid">
      {shown.map((vehicle, index) => <li key={vehicle.id}>
        <VehicleCard vehicle={vehicle} eligibility={eligibilityOf(vehicle.id)} priority={index < 3} onDetails={() => setOpen(vehicle)} />
      </li>)}
    </ul> : <section className="cw-showroom-state cw-showroom-empty">
      <span className="cw-showroom-state-icon"><ChatIcon name="search" /></span>
      <h2>לא נמצאו רכבים שמתאימים לסינון</h2>
      <p>אפשר לשנות את החיפוש או לאפס את הסינון ולראות את כל הקטלוג.</p>
      <button type="button" className="cw-showroom-primary" onClick={() => setFilters(EMPTY_FILTERS)}><ChatIcon name="reset" />איפוס סינון</button>
    </section>}

    <p className="cw-showroom-footnote">
      הרכבים, הקבוצות וסוגי ההנעה נלקחים מקטלוג החברה הפעיל. הזכאות מחושבת לפי הפרופיל המאושר שלך וכללי החברה.
      התמונות הן הדמיות AI להמחשה בלבד. ייתכנו הבדלים בין ההדמיה לדגם ולרמת הגימור בפועל.
    </p>

    {open && <VehicleDetails vehicle={open} eligibility={eligibilityOf(open.id)} onClose={() => setOpen(null)} />}
  </div>;
}

function ChipGroup({ label, value, options, onChange }: {
  label: string; value: string; onChange: (value: string) => void;
  options: Array<{ value: string; label: string; icon?: ChatIconName }>;
}) {
  return <div className="cw-showroom-chips" role="radiogroup" aria-label={label}>
    <span className="cw-showroom-chips-label" aria-hidden="true">{label}</span>
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
      className={`cw-chip ${value === option.value ? 'cw-chip-on' : ''}`} onClick={() => onChange(option.value)}>
      {option.icon && <ChatIcon name={option.icon} />}{option.label}
    </button>)}
  </div>;
}

function Badges({ vehicle }: { vehicle: ShowroomVehicle }) {
  const drive = propulsion(vehicle.drive_type);
  return <div className="cw-vehicle-badges">
    <span className={`cw-badge ${vehicle.group_code === FAMILY_GROUP ? 'cw-badge-family' : ''}`}>{groupLabel(vehicle.group_code)}</span>
    <span className={`cw-badge cw-badge-drive cw-badge-${drive.icon}`}><ChatIcon name={drive.icon} />{drive.badge}</span>
  </div>;
}

function EligibilityPill({ eligibility }: { eligibility: ShowroomEligibility }) {
  const icon: ChatIconName = eligibility.status === 'eligible' ? 'check' : eligibility.status === 'ineligible' ? 'close' : 'info';
  return <p className={`cw-eligibility cw-eligibility-${eligibility.status}`} title={eligibility.reason}>
    <ChatIcon name={icon} /><span>{eligibilityLabel(eligibility.status)}</span>
  </p>;
}

function Tiles({ vehicle }: { vehicle: ShowroomVehicle }) {
  const drive = propulsion(vehicle.drive_type);
  const tiles: Array<{ icon: ChatIconName; value: string; label: string; ltr?: boolean }> = [
    { icon: drive.icon, value: drive.tile, label: 'הנעה' },
    { icon: vehicle.group_code === FAMILY_GROUP ? 'users' : 'layers', value: vehicle.group_code === FAMILY_GROUP ? 'משפחתי' : vehicle.group_code, label: vehicle.group_code === FAMILY_GROUP ? 'מסלול' : 'קבוצת רכב' },
    { icon: 'factory', value: vehicle.manufacturer_name, label: 'יצרן' }
  ];
  return <dl className="cw-vehicle-tiles">{tiles.map(tile => <div key={tile.label} className="cw-vehicle-tile">
    <ChatIcon name={tile.icon} /><dt>{tile.label}</dt><dd>{tile.value}</dd>
  </div>)}</dl>;
}

/** The primary action: the existing chat flow for this exact catalog ID (eligibility, missing details, approval, calculation). */
function NetImpactAction({ vehicle, eligibility, large = false }: { vehicle: ShowroomVehicle; eligibility: ShowroomEligibility; large?: boolean }) {
  const ineligible = eligibility.status === 'ineligible';
  return <Link href={netImpactHref(vehicle.id)} className={`${ineligible ? 'cw-showroom-secondary' : 'cw-showroom-primary'} ${large ? 'cw-showroom-action-large' : ''}`}
    aria-label={ineligible ? `בירור הזכאות ל־${vehicle.display_name} בשיחה` : `חישוב ההשפעה של ${vehicle.display_name} על הנטו, בשיחה`}>
    <ChatIcon name={ineligible ? 'chat' : 'calculator'} />
    <span>{ineligible ? 'בירור הזכאות בשיחה' : 'חשבו את ההשפעה על הנטו'}</span>
  </Link>;
}

/**
 * A click anywhere on the card (photo included) opens the vehicle's details, except on the card's own controls, which
 * keep their actions; dragging to select text does not open it either. For keyboard users the model name is the
 * details button, so the card adds no extra tab stop.
 */
export function cardClickOpensDetails(target: EventTarget | null, selectedText = '') {
  if (selectedText.trim()) return false;
  return !(typeof Element !== 'undefined' && target instanceof Element && target.closest('a, button, input, select, textarea, label, [role="button"]'));
}

function VehicleCard({ vehicle, eligibility, priority, onDetails }: {
  vehicle: ShowroomVehicle; eligibility: ShowroomEligibility; priority: boolean; onDetails: () => void;
}) {
  const titleId = useId();
  return <article className={`cw-vehicle-card cw-vehicle-card-clickable cw-vehicle-${eligibility.status}`} aria-labelledby={titleId}
    onClick={event => { if (cardClickOpensDetails(event.target, window.getSelection()?.toString())) onDetails(); }}>
    <div className="cw-vehicle-media">
      <VehiclePhoto vehicle={vehicle} sizes={CARD_SIZES} priority={priority} />
      <Badges vehicle={vehicle} />
    </div>
    <div className="cw-vehicle-body">
      <div className="cw-vehicle-heading">
        <div>
          <h2 id={titleId}><button type="button" className="cw-vehicle-title-button" onClick={onDetails} aria-haspopup="dialog"
            aria-label={`פרטים ותמונות של ${vehicle.display_name}`}><bdi dir="ltr">{vehicle.display_name}</bdi></button></h2>
          <p className="cw-vehicle-maker">{vehicle.manufacturer_name}</p>
        </div>
        <EligibilityPill eligibility={eligibility} />
      </div>
      <Tiles vehicle={vehicle} />
      <div className="cw-vehicle-actions">
        <NetImpactAction vehicle={vehicle} eligibility={eligibility} />
        <button type="button" className="cw-showroom-ghost" onClick={onDetails} aria-haspopup="dialog">
          <ChatIcon name="image" /><span>תמונות ופרטים נוספים</span>
        </button>
      </div>
    </div>
  </article>;
}

function VehicleDetails({ vehicle, eligibility, onClose }: { vehicle: ShowroomVehicle; eligibility: ShowroomEligibility; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(false);
  const titleId = useId();
  const photo = vehiclePhoto(vehicle.id);
  const drive = propulsion(vehicle.drive_type);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    if (element && !element.open) element.showModal();
    return () => previous?.focus();
  }, []);
  return <><dialog ref={dialog} className="cw-vehicle-dialog" aria-labelledby={titleId} dir="rtl"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) onClose(); }}>
    {/* Outside the scrolling area, so the close button stays in view while the details scroll. */}
    <button type="button" className="cw-vehicle-dialog-close" aria-label="סגירת פרטי הרכב" onClick={onClose}><ChatIcon name="close" /></button>
    <div className="cw-vehicle-dialog-inner">
      <div className="cw-vehicle-dialog-media">
        <VehiclePhoto vehicle={vehicle} sizes="(max-width: 900px) 100vw, 880px" priority large />
        <Badges vehicle={vehicle} />
        {photo && <button type="button" className="cw-photo-zoom" aria-label={`הגדלת תמונת ${vehicle.display_name}`} onClick={()=>setZoom(true)}><ChatIcon name="image" />הגדלת תמונה</button>}
      </div>
      <div className="cw-vehicle-dialog-body">
        <div className="cw-vehicle-heading">
          <div>
            <h2 id={titleId}><bdi dir="ltr">{vehicle.display_name}</bdi></h2>
            <p className="cw-vehicle-maker">{vehicle.manufacturer_name}</p>
          </div>
          <EligibilityPill eligibility={eligibility} />
        </div>
        <div className={`cw-eligibility-panel cw-eligibility-panel-${eligibility.status}`}>
          <strong>{eligibilityLabel(eligibility.status)}</strong>
          <p>{eligibility.reason}{eligibility.status === 'ineligible' ? ' אפשר לברר בשיחה אילו רכבים כן כלולים בזכאות שלך.' : ''}</p>
        </div>
        <h3>פרטים מקטלוג החברה</h3>
        <dl className="cw-vehicle-facts">
          <div><dt>דגם</dt><dd><bdi dir="ltr">{vehicle.display_name}</bdi></dd></div>
          <div><dt>יצרן</dt><dd>{vehicle.manufacturer_name}</dd></div>
          <div><dt>קבוצת רכב</dt><dd>{groupLabel(vehicle.group_code)}</dd></div>
          <div><dt>הנעה</dt><dd>{drive.badge}</dd></div>
          <div><dt>מזהה בקטלוג</dt><dd><bdi dir="ltr">{vehicle.id}</bdi></dd></div>
        </dl>
        <p className="cw-vehicle-unverified"><ChatIcon name="info" />מספר מושבים, טווח נסיעה, ביצועים ואבזור אינם מופיעים בקטלוג החברה, ולכן לא מוצגים כאן.</p>
        <div className="cw-vehicle-dialog-actions">
          <NetImpactAction vehicle={vehicle} eligibility={eligibility} large />
          <p>החישוב נעשה בשיחה עם CarWise, לפי הפרטים המאושרים שלך. אם חסר פרט, CarWise ישאל עליו לפני החישוב.</p>
        </div>
        
      </div>
    </div>
  </dialog>{zoom && <VehicleImageViewer vehicle={vehicle} onClose={()=>setZoom(false)} />}</>;
}
