'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import type { PayslipField, PayslipReview } from '@/lib/payslip/payslip-contract';
import {
  applyPayslipToForm, changedProfileFields, initialProfileForm, NO_VEHICLE, PROFILE_NUMBER_FIELDS, splitDisplayName, validateProfileForm,
  type ProfileErrors, type ProfileFormField, type ProfileFormValues, type ProfileNumberField, type ProfileSnapshot
} from '@/lib/profile/profile-form';
import type { OwnProfile } from '@/lib/profile/profile-service';
import { groupLabel } from '@/lib/catalog/showroom';
import { ChatSidebar, initials } from '../chat/chat-sidebar';
import { ChatIcon, type ChatIconName } from '../chat/chat-icon';
import { rememberActiveConversation } from '../chat/use-employee-chat';
import { useConversationList } from '../chat/use-conversation-list';
import type { EmployeeAccount } from '../chat/employee-chat';
import { CarWiseCarLoader } from '../ui/carwise-car-loader';
import { OccupationPicker } from './occupation-picker';
import '../chat/employee-chat.css';
import './profile.css';

// The payslip dialog is loaded only when the employee chooses to upload.
const PayslipUpload = dynamic(() => import('../chat/payslip-upload').then(module => module.PayslipUpload), { ssr: false });

type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;
const dateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';

export function ProfileApp({ userId, account, accountName, data }: {
  userId: string; account?: EmployeeAccount;
  /** The account's stored name; null when none is stored (the form then asks for it). */
  accountName: { firstName: string; lastName: string } | null;
  data: OwnProfile;
}) {
  const router = useRouter();
  const list = useConversationList();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const needsName = accountName === null;
  const nameOf = useCallback((snapshot: ProfileSnapshot | null) => accountName ?? splitDisplayName(snapshot?.displayName), [accountName]);
  const [snapshot, setSnapshot] = useState(data.snapshot);
  const [baseline, setBaseline] = useState(() => initialProfileForm(data.snapshot, nameOf(data.snapshot)));
  const [form, setForm] = useState(baseline);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [payslipOpen, setPayslipOpen] = useState(false);
  const [fromPayslip, setFromPayslip] = useState<ReadonlySet<PayslipField>>(new Set());
  const firstField = useRef<HTMLInputElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const occupations = useMemo(() => data.occupations ?? [], [data.occupations]);
  const vehicles = useMemo(() => [...(data.vehicles ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name, 'he')), [data.vehicles]);
  const occupationKeys = useMemo(() => new Set(occupations.map(item => item.key)), [occupations]);
  const vehicleIds = useMemo(() => new Set(vehicles.map(item => item.id)), [vehicles]);
  const chosenOccupation = occupations.find(item => item.key === form.occupationKey);
  const changed = changedProfileFields(form, baseline);
  const dirty = changed.length > 0;
  const blocked = data.occupations === null || data.vehicles === null || data.profileUnavailable || occupations.length === 0;

  // Unsaved changes are not lost by accident: closing/reloading the tab, or following a link inside the app.
  useEffect(() => {
    if (!dirty) return;
    const message = 'יש בפרופיל שינויים שלא נשמרו. לצאת בלי לשמור?';
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = message; };
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || event.defaultPrevented || link.getAttribute('aria-disabled') === 'true') return;
      const url = new URL(link.getAttribute('href')!, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === '/profile') return;
      if (!window.confirm(message)) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', click, true); };
  }, [dirty]);

  const openConversation = (id: string | null) => {
    if (dirty && !window.confirm('יש בפרופיל שינויים שלא נשמרו. לצאת בלי לשמור?')) return;
    rememberActiveConversation(userId, id);
    router.push(id ? `/employee?${new URLSearchParams({ conversation: id })}` : '/employee');
  };
  const set = (field: ProfileFormField, value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    setErrors(current => { if (!current[field]) return current; const next = { ...current }; delete next[field]; return next; });
    if (field in PROFILE_NUMBER_FIELDS) setFromPayslip(current => { if (!current.has(field as PayslipField)) return current; const next = new Set(current); next.delete(field as PayslipField); return next; });
    if (notice?.tone === 'success') setNotice(null);
  };
  const show = (next: Notice) => { setNotice(next); requestAnimationFrame(() => noticeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); };
  const resetTo = (next: ProfileSnapshot | null) => {
    const fresh = initialProfileForm(next, nameOf(next));
    setSnapshot(next); setBaseline(fresh); setForm(fresh); setErrors({}); setFromPayslip(new Set());
  };

  const applyPayslip = (review: PayslipReview) => {
    const { form: next, applied } = applyPayslipToForm(form, review);
    setForm(next); setFromPayslip(new Set(applied));
    setErrors(current => { const copy = { ...current }; for (const field of applied) delete copy[field]; return copy; });
    show(applied.length
      ? { tone: 'info', text: `${applied.length === 1 ? 'ערך אחד הועבר' : `${applied.length} ערכים הועברו`} מהתלוש לטופס (מסומנים "מהתלוש"). כדאי לבדוק אותם ולהשלים את השאר, ואז לשמור. שום דבר לא נשמר עדיין.` }
      : { tone: 'info', text: 'לא הועברו ערכים מהתלוש. אפשר להמשיך במילוי ידני.' });
  };

  async function save() {
    if (saving || blocked) return;
    const result = validateProfileForm(form, { needsName, basedOnVersionId: snapshot?.versionId ?? null, occupationKeys, vehicleIds });
    if (result.errors) {
      setErrors(result.errors);
      show({ tone: 'error', text: 'יש לתקן את השדות המסומנים לפני השמירה.' });
      setTimeout(() => document.querySelector<HTMLElement>('.cw-profile-form [aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setSaving(true); setNotice(null);
    try {
      const response = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        credentials: 'same-origin', body: JSON.stringify(result.payload) });
      const body = await response.json().catch(() => ({})) as { status?: string; snapshot?: ProfileSnapshot | null; error?: string; code?: string };
      if (response.ok && body.snapshot) {
        resetTo(body.snapshot);
        show(body.status === 'unchanged'
          ? { tone: 'info', text: 'לא היו שינויים לשמור. הפרופיל המאושר נשאר כפי שהוא.' }
          : { tone: 'success', text: 'הפרופיל נשמר. מעכשיו החישובים, הזכאות וההמלצות מתבססים על הנתונים המעודכנים.' });
        // The response already holds the saved version; other pages (catalog eligibility, the chat, Match) are rendered
        // per request and read it on their next visit, so nothing needs reloading here.
        return;
      }
      if (response.status === 409 && body.code === 'stale') { resetTo(body.snapshot ?? null); show({ tone: 'error', text: body.error ?? 'הפרופיל עודכן בינתיים.' }); return; }
      if (response.status === 401) { show({ tone: 'error', text: 'כדי לשמור, צריך להתחבר שוב לחשבון.' }); return; }
      if (body.code === 'invalid_occupation') setErrors({ occupationKey: body.error });
      if (body.code === 'invalid_vehicle') setErrors({ current_vehicle_id: body.error });
      show({ tone: 'error', text: body.error ?? 'לא הצלחתי לשמור את הפרופיל כרגע. אפשר לנסות שוב.' });
    } catch {
      show({ tone: 'error', text: 'משהו השתבש בחיבור, והפרופיל לא נשמר. אפשר לנסות שוב.' });
    } finally { setSaving(false); }
  }

  const displayName = accountName ? `${accountName.firstName} ${accountName.lastName}`.trim() : `${form.firstName} ${form.lastName}`.trim();
  const fieldProps = (field: ProfileNumberField) => ({ field, value: form[field], error: errors[field], onChange: (value: string) => set(field, value),
    fromPayslip: fromPayslip.has(field as PayslipField), changed: changed.includes(field) });

  return <main className="cw-app cw-profile-app" dir="rtl">
    <a href="#cw-profile-main" className="cw-skip-link">מעבר לטופס הפרופיל</a>
    <ChatSidebar conversations={list.conversations} titles={{}} activeId={null} section="profile" account={account}
      open={sidebarOpen} onClose={closeSidebar} locked={false} loading={list.loading} error={list.error} hasMore={Boolean(list.cursor)}
      onLoadMore={() => void list.load(list.cursor)} onRetry={() => void list.load()} onSelect={id => { closeSidebar(); openConversation(id); }} />
    <div className="cw-workspace" inert={sidebarOpen || undefined}>
      <header className="cw-topbar">
        <div className="cw-topbar-title">
          <button className="cw-icon-button cw-menu-toggle" aria-label="פתיחת התפריט" aria-expanded={sidebarOpen} aria-controls="cw-sidebar" onClick={() => setSidebarOpen(true)}><ChatIcon name="menu" /></button>
          <span className="cw-topbar-symbol"><ChatIcon name="user" /></span>
          <div><strong>הפרופיל שלי</strong><span>הנתונים שעליהם CarWise מחשב עבורך</span></div>
        </div>
        <Link href="/employee" className="cw-profile-home" aria-label="חזרה לדף הבית"><ChatIcon name="back" /><span>חזרה לדף הבית</span></Link>
      </header>

      <div id="cw-profile-main" className="cw-profile-scroll" tabIndex={-1}>
        <div className="cw-profile">
          <section className="cw-profile-hero" aria-labelledby="cw-profile-title">
            <span className="cw-profile-avatar" aria-hidden="true">{displayName ? initials(displayName) : <ChatIcon name="user" />}</span>
            <div className="cw-profile-hero-text">
              <h1 id="cw-profile-title">{displayName || 'הפרופיל שלי'}</h1>
              <p>{snapshot
                ? <>פרופיל מאושר · עודכן {dateTime(snapshot.confirmedAt)}{chosenOccupation ? <> · {chosenOccupation.title}</> : null}</>
                : 'עדיין אין פרופיל מאושר. אחרי השמירה, CarWise יחשב ויבדוק זכאות לפי הנתונים האלה.'}</p>
            </div>
          </section>

          <section className="cw-profile-modes" aria-label="דרך עדכון הפרופיל">
            <button type="button" className="cw-profile-mode" onClick={() => firstField.current?.focus()}>
              <span className="cw-profile-mode-icon"><ChatIcon name="calculator" /></span>
              <span><strong>מילוי ידני</strong><small>עריכת הנתונים ישירות בטופס שלמטה</small></span>
            </button>
            <button type="button" className="cw-profile-mode cw-profile-mode-upload" onClick={() => setPayslipOpen(true)} disabled={blocked} aria-haspopup="dialog">
              <span className="cw-profile-mode-icon"><ChatIcon name="upload" /></span>
              <span><strong>העלאת תלוש שכר</strong><small>CarWise יציע את הערכים מהתלוש, ואתם בודקים ומאשרים</small></span>
            </button>
          </section>

          <div ref={noticeRef} aria-live="polite">{notice && <p className={`cw-profile-notice cw-profile-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            <ChatIcon name={notice.tone === 'success' ? 'check' : notice.tone === 'error' ? 'alert' : 'info'} />{notice.text}</p>}</div>

          {blocked && <div className="cw-profile-notice cw-profile-notice-error" role="alert">
            <ChatIcon name="alert" />
            <span>{data.profileUnavailable ? 'לא הצלחתי לטעון כרגע את הפרופיל השמור, ולכן אי אפשר לערוך אותו (כדי לא לדרוס נתונים).'
              : data.occupations === null ? 'לא הצלחתי לטעון את רשימת התפקידים הרשמית.'
              : occupations.length === 0 ? 'רשימת התפקידים הרשמית ריקה כרגע, ולכן אי אפשר לשמור פרופיל.'
              : 'לא הצלחתי לטעון את קטלוג הרכבים.'} אפשר לנסות שוב בעוד רגע.</span>
            <button type="button" onClick={() => router.refresh()}><ChatIcon name="retry" />ניסיון חוזר</button>
          </div>}

          <form className="cw-profile-form" noValidate onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={saving}>
            <ProfileCard icon="user" title="פרטים אישיים">
              <div className="cw-profile-grid">
                <TextField label="שם פרטי" value={form.firstName} readOnly={!needsName} error={errors.firstName} autoComplete="given-name"
                  onChange={value => set('firstName', value)} inputRef={needsName ? firstField : undefined} />
                <TextField label="שם משפחה" value={form.lastName} readOnly={!needsName} error={errors.lastName} autoComplete="family-name"
                  onChange={value => set('lastName', value)} />
              </div>
              {!needsName && <p className="cw-profile-hint">השם נלקח מפרטי החשבון. לשינוי השם יש לפנות לתמיכה.</p>}
            </ProfileCard>

            <ProfileCard icon="layers" title="תפקיד וזכאות" lead="התפקיד קובע את קבוצת הזכאות לרכב. הרשימה היא רשימת התפקידים הרשמית של החברה.">
              <Field label="תפקיד בארגון" error={errors.occupationKey} changed={changed.includes('occupationKey')}>
                {(id, describedBy) => data.occupations === null ? <p id={id} className="cw-profile-hint">רשימת התפקידים אינה זמינה כרגע.</p>
                  : <OccupationPicker occupations={occupations} value={form.occupationKey} onChange={key => set('occupationKey', key)}
                    invalid={Boolean(errors.occupationKey)} describedBy={describedBy} disabled={blocked} />}
              </Field>
              {snapshot && !snapshot.occupationKey && !form.occupationKey && data.occupations && <p className="cw-profile-hint cw-profile-hint-warn">
                התפקיד השמור ("{snapshot.occupationTitle}") אינו מופיע ברשימה הרשמית. יש לבחור תפקיד מהרשימה.</p>}
              {chosenOccupation && <div className="cw-profile-eligibility">
                <span className="cw-profile-eligibility-group">{groupLabel(chosenOccupation.group_code)}</span>
                <span>{chosenOccupation.car_mandatory ? 'בתפקיד הזה רכב צמוד הוא חלק מהתפקיד (חובה).'
                  : chosenOccupation.waiver_allowed ? 'בתפקיד הזה אפשר לבחור רכב צמוד או לוותר עליו.' : 'בתפקיד הזה אפשר לבחור רכב צמוד.'}</span>
              </div>}
              <div className="cw-profile-grid">
                <NumberField {...fieldProps('eligible_children_count')} hint="משפיע על הזכאות למסלול המשפחתי." />
              </div>
            </ProfileCard>

            <ProfileCard icon="wallet" title="שכר והפרשות" lead="כפי שמופיע בתלוש השכר החודשי. אם אין עמלות או בונוס, יש להזין 0.">
              <div className="cw-profile-grid cw-profile-grid-3">
                <NumberField {...fieldProps('base_salary')} inputRef={needsName ? undefined : firstField} />
                <NumberField {...fieldProps('commissions')} />
                <NumberField {...fieldProps('bonus')} />
                <NumberField {...fieldProps('employee_pension_percent')} />
                <NumberField {...fieldProps('employee_study_fund_percent')} />
                <NumberField {...fieldProps('tax_credit_points')} hint="מופיע בתלוש השכר, למשל 2.25." />
              </div>
            </ProfileCard>

            <ProfileCard icon="car" title="הרכב שלך היום" lead="הרכב הצמוד הנוכחי הוא נקודת ההשוואה לכל חישוב.">
              <div className="cw-profile-grid">
                <Field label="רכב צמוד נוכחי" error={errors.current_vehicle_id} changed={changed.includes('current_vehicle_id')}>
                  {(id, describedBy) => <select id={id} className="cw-profile-select" value={form.current_vehicle_id} disabled={data.vehicles === null}
                    aria-invalid={Boolean(errors.current_vehicle_id) || undefined} aria-describedby={describedBy}
                    onChange={event => {
                      const next = event.target.value;
                      // No company car: participation is 0 by definition. A car instead of "none": its participation is asked anew.
                      if (next === NO_VEHICLE) set('current_participation', '0');
                      else if (form.current_vehicle_id === NO_VEHICLE) set('current_participation', '');
                      set('current_vehicle_id', next);
                    }}>
                    <option value="" disabled>בחירת רכב…</option>
                    <option value={NO_VEHICLE}>אין לי רכב צמוד מהחברה</option>
                    {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.display_name} · {vehicle.manufacturer_name}</option>)}
                    {snapshot?.current_vehicle_id && !vehicleIds.has(snapshot.current_vehicle_id) && data.vehicles &&
                      <option value={snapshot.current_vehicle_id} disabled>{snapshot.current_vehicle_id} (לא בקטלוג הפעיל)</option>}
                  </select>}
                </Field>
                {form.current_vehicle_id !== NO_VEHICLE && <NumberField {...fieldProps('current_participation')} hint="הסכום החודשי שמנוכה היום מהשכר עבור הרכב." />}
              </div>
            </ProfileCard>

            <p className="cw-profile-footnote"><ChatIcon name="shield" />הנתונים הם הצהרה שלך ואינם מאומתים מול מערכת השכר. הם נשמרים בחשבון שלך בלבד ומשמשים לחישובים ולהמלצות עבורך, גם בשיחה עם CarWise.</p>

            <div className="cw-profile-actions">
              <span className="cw-profile-actions-status" aria-live="polite">{saving ? '' : dirty ? `${changed.length === 1 ? 'שינוי אחד' : `${changed.length} שינויים`} שלא נשמרו` : snapshot ? 'הכול שמור' : ''}</span>
              <button type="button" className="cw-profile-secondary" disabled={!dirty || saving} onClick={() => { setForm(baseline); setErrors({}); setFromPayslip(new Set()); setNotice(null); }}>ביטול שינויים</button>
              <button type="submit" className="cw-profile-primary" disabled={saving || blocked}>
                {saving ? <CarWiseCarLoader variant="button" label="שומרים…" /> : <><ChatIcon name="check" />שמירת הפרופיל</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
    {payslipOpen && <PayslipUpload endpoint="/api/profile/payslip" destination="profile" onSubmit={review => applyPayslip(review)} onClose={() => setPayslipOpen(false)} />}
  </main>;
}

function ProfileCard({ icon, title, lead, children }: { icon: ChatIconName; title: string; lead?: string; children: ReactNode }) {
  const id = useId();
  return <section className="cw-profile-card" aria-labelledby={id}>
    <header><span className="cw-profile-card-icon" aria-hidden="true"><ChatIcon name={icon} /></span><div><h2 id={id}>{title}</h2>{lead && <p>{lead}</p>}</div></header>
    {children}
  </section>;
}

function Field({ label, error, hint, changed, badge, children }: {
  label: string; error?: string; hint?: string; changed?: boolean; badge?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return <div className={`cw-profile-field ${error ? 'cw-profile-field-error' : ''}`}>
    <div className="cw-profile-label"><label htmlFor={id}>{label}</label>
      {badge && <span className="cw-profile-badge cw-profile-badge-payslip">{badge}</span>}
      {changed && !badge && <span className="cw-profile-badge">שונה</span>}</div>
    {children(id, describedBy)}
    {hint && <small id={`${id}-hint`} className="cw-profile-hint">{hint}</small>}
    {error && <small id={`${id}-error`} className="cw-profile-error">{error}</small>}
  </div>;
}

function NumberField({ field, value, error, hint, changed, fromPayslip, onChange, inputRef }: {
  field: ProfileNumberField; value: string; error?: string; hint?: string; changed: boolean; fromPayslip: boolean;
  onChange: (value: string) => void; inputRef?: Ref<HTMLInputElement>;
}) {
  const spec = PROFILE_NUMBER_FIELDS[field];
  return <Field label={spec.label} error={error} hint={hint} changed={changed} badge={fromPayslip ? 'מהתלוש' : undefined}>
    {(id, describedBy) => <span className="cw-profile-input">
      <input ref={inputRef} id={id} className="cw-placeholder-rtl" inputMode={spec.integer ? 'numeric' : 'decimal'} dir="ltr" autoComplete="off"
        value={value} placeholder="ריק" aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy}
        onChange={event => onChange(event.target.value)} />
      <span className="cw-profile-unit" aria-hidden="true">{spec.unit}</span>
    </span>}
  </Field>;
}

function TextField({ label, value, readOnly, error, autoComplete, onChange, inputRef }: {
  label: string; value: string; readOnly: boolean; error?: string; autoComplete: string; onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return <Field label={label} error={error}>
    {(id, describedBy) => <span className="cw-profile-input">
      <input ref={inputRef} id={id} type="text" dir="auto" maxLength={60} autoComplete={autoComplete} value={value} readOnly={readOnly}
        aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy} onChange={event => onChange(event.target.value)} />
      {readOnly && <span className="cw-profile-unit" aria-hidden="true"><ChatIcon name="shield" /></span>}
    </span>}
  </Field>;
}
