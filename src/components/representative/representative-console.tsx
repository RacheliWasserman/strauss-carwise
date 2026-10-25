'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import {
  encodeRepAnswer, encodeRepReply, fieldFromTopic, formatAnswerValue, REP_ANSWER_KIND, REP_REPLY_KIND, REP_REPLY_MAX, REQUESTABLE_FIELDS,
  requestableFieldSchema, validateAnswerValue, type RequestableField
} from '../../lib/representative-answer';
import { isOverdue, matchesQuery, OVERDUE_MINUTES, waitingText, type QueueFilter } from '../../lib/representative-queue-view';
import { CarWiseCarLoader } from '../ui/carwise-car-loader';

/**
 * Representative dashboard. Shows each request's missing field, its question, the employee's name and minimal
 * metadata. It never loads the conversation, salary summary, calculations or national ID: the API refuses those to
 * representatives, and migration 202610210002 enforces the same in the database.
 */
export const requestSchema = z.object({
  id: z.string().uuid(), conversation_id: z.string().uuid(), status: z.enum(['open', 'claimed', 'answered', 'closed', 'cancelled']),
  topic: z.string().nullable(), assigned_representative_id: z.string().uuid().nullable(),
  requested_at: z.string(), answered_at: z.string().nullable(), employee_name: z.string().max(130).nullable().optional(),
  occupation: z.string().max(120).nullable().optional(),
  // Last four digits only, to tell identical names apart. The full ID is never part of the queue.
  employee_id_last4: z.string().regex(/^\d{4}$/).nullable().optional()
});
// What this representative sent: a structured value for a missing-field request, or free text for a general request.
const answerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), requestId: z.string().uuid(), field: requestableFieldSchema, value: z.number(), note: z.string().optional(), answeredAt: z.string() }),
  z.object({ kind: z.literal('general'), requestId: z.string().uuid(), text: z.string(), answeredAt: z.string() })
]);
type Request = z.infer<typeof requestSchema>;
type Answer = z.infer<typeof answerSchema>;
const time = (value: string) => new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));

async function readError(response: Response, fallback: string) {
  try { const data = await response.json(); return typeof data.error === 'string' ? data.error : fallback; } catch { return fallback; }
}

/** Publish one coherent snapshot; an answer-list failure must not silently leave old answers on screen. */
export async function loadRepresentativeData(signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const [queue, sent] = await Promise.all([
    fetcher('/api/representative-requests', { cache: 'no-store', credentials: 'same-origin', signal }),
    fetcher('/api/representative-requests/answers', { cache: 'no-store', credentials: 'same-origin', signal })
  ]);
  if (!queue.ok) throw new Error(await readError(queue, 'לא הצלחנו לטעון את הפניות.'));
  if (!sent.ok) throw new Error(await readError(sent, 'לא הצלחנו לטעון את התשובות שנשלחו.'));
  const [queueBody, answerBody] = await Promise.all([queue.json(), sent.json()]);
  const requests = z.object({ requests: z.array(requestSchema) }).safeParse(queueBody);
  const answers = z.object({ answers: z.array(answerSchema) }).safeParse(answerBody);
  if (!requests.success || !answers.success) throw new Error('התקבלו נתונים לא תקינים. אפשר לרענן ולנסות שוב.');
  return { requests: requests.data.requests.sort((a, b) => a.requested_at.localeCompare(b.requested_at)),
    answers: new Map(answers.data.answers.map(answer => [answer.requestId, answer])) };
}

function Pill({ tone, children }: { tone: 'waiting' | 'mine' | 'done'; children: React.ReactNode }) {
  const tones = { waiting: 'bg-amber-50 text-amber-800 ring-amber-200', mine: 'bg-sky-50 text-sky-800 ring-sky-200', done: 'bg-emerald-50 text-emerald-800 ring-emerald-200' };
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${tones[tone]}`}>{children}</span>;
}

/** A small counter that is also the status filter (the existing statuses only). */
function StatusFilter({ label, value, tone, active, onSelect }: { label: string; value: number | null; tone: string; active: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} aria-pressed={active}
    className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#137c77] ${active ? 'bg-[#123f50] text-white ring-[#123f50]' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'}`}>
    {label}<span className={`min-w-[1.5rem] rounded-full px-1.5 text-center text-xs tabular-nums ${active ? 'bg-white/20 text-white' : `bg-slate-100 ${tone}`}`}>{value ?? '–'}</span>
  </button>;
}

export function RequestHeader({ request, field, pill, now }: { request: Request; field: RequestableField | null; pill: React.ReactNode; now: number }) {
  const overdue = isOverdue(request, now);
  return <>
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
      <div className="min-w-0 flex-1">
        {/* The account's stored name, read on the server. A missing name means the identity record does not exist yet. */}
        <p className="text-sm font-bold text-slate-900">{request.employee_name
          ? <bdi>{request.employee_name}</bdi>
          : <span className="font-semibold text-slate-500">שם לא זמין (פרטי הזהות עוד לא נשמרו)</span>}
          {request.occupation && <span className="font-normal text-slate-600"> · <bdi>{request.occupation}</bdi></span>}
          {request.employee_id_last4 && <span className="font-normal text-slate-600"> · ת״ז <bdi dir="ltr">•••••{request.employee_id_last4}</bdi></span>}</p>
        <h3 className="mt-0.5 text-[15px] font-bold leading-snug text-[#123f50]">{field ? REQUESTABLE_FIELDS[field].label : 'פנייה כללית'}</h3>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {overdue && <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-800 ring-1 ring-rose-200">מעל {OVERDUE_MINUTES} דקות</span>}
        {pill}
      </div>
    </div>
    <p className="mt-1 text-sm leading-relaxed text-slate-700">{field ? REQUESTABLE_FIELDS[field].question : request.topic ?? 'ללא נושא'}</p>
    <p className="mt-1 text-xs text-slate-500">מספר פנייה <bdi>#{request.id.slice(0, 6)}</bdi> · נפתחה <time dateTime={request.requested_at}>{time(request.requested_at)}</time>
      {' · '}<span className={overdue ? 'font-semibold text-rose-700' : 'font-medium text-slate-700'}>{waitingText(request, now)}</span></p>
  </>;
}

/**
 * The full national ID, fetched only on an explicit click by the representative who claimed this request.
 * Kept in this component's memory only (never storage), hidden again after a minute, and dropped as soon as the request
 * changes or leaves "בטיפולי" (answered, closed, cancelled or reassigned), because the card then unmounts.
 */
export function NationalIdReveal({ request }: { request: Request }) {
  const [state, setState] = useState<{ kind: 'hidden' | 'loading' | 'error' } | { kind: 'shown'; id: string }>({ kind: 'hidden' });
  useEffect(() => { setState({ kind: 'hidden' }); }, [request.id, request.status, request.assigned_representative_id]);
  useEffect(() => {
    if (state.kind !== 'shown') return;
    const timer = window.setTimeout(() => setState({ kind: 'hidden' }), 60_000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const reveal = async () => {
    setState({ kind: 'loading' });
    try {
      const response = await fetch(`/api/representative-requests/${request.id}/national-id`, { method: 'POST', cache: 'no-store', credentials: 'same-origin' });
      const data: unknown = await response.json().catch(() => null);
      const id = response.ok && data && typeof data === 'object' && 'nationalId' in data && typeof data.nationalId === 'string' && /^\d{9}$/.test(data.nationalId) ? data.nationalId : null;
      setState(id ? { kind: 'shown', id } : { kind: 'error' });
    } catch { setState({ kind: 'error' }); }
  };
  return <div className="flex flex-wrap items-center gap-3 text-sm">
    {state.kind === 'shown'
      ? <><span className="rounded-lg bg-slate-100 px-3 py-1.5 font-semibold text-slate-900 ring-1 ring-slate-200">ת״ז מלאה: <bdi dir="ltr">{state.id}</bdi></span>
        <button type="button" onClick={() => setState({ kind: 'hidden' })} className="font-semibold text-[#123f50] underline">הסתרה</button></>
      : <button type="button" onClick={() => void reveal()} disabled={state.kind === 'loading'}
          className="inline-flex items-center rounded-lg bg-white px-3 py-1.5 font-semibold text-[#123f50] ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-70">
          {state.kind === 'loading' ? <CarWiseCarLoader variant="button" label="רגע…" /> : 'הצגת ת״ז מלאה'}</button>}
    {state.kind === 'error' && <span role="alert" className="text-rose-700">לא ניתן להציג את הפרט כרגע.</span>}
    <span className="text-xs text-slate-500">זמין רק בזמן שהפנייה בטיפולך. כל הצגה נרשמת.</span>
  </div>;
}

/**
 * Free-text reply to a GENERAL request (no missing field). It is linked to this request and shown to the employee as a
 * message; it never changes profile values (missing-field requests keep the structured form and employee approval).
 */
export function GeneralReplyForm({ request, onSent }: { request: Request; onSent: (message: string) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const inputId = `reply-${request.id}`;
  const submit = async () => {
    if (sending) return;
    const clean = text.trim();
    if (!clean) { setError('יש לכתוב תשובה.'); return; }
    setSending(true); setError('');
    try {
      const body = encodeRepReply({ kind: REP_REPLY_KIND, requestId: request.id, text: clean.slice(0, REP_REPLY_MAX), answeredAt: new Date().toISOString() });
      const response = await fetch(`/api/conversations/${request.conversation_id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ body, clientMessageId: crypto.randomUUID() })
      });
      if (!response.ok) throw new Error(await readError(response, 'לא הצלחנו לשלוח את התשובה.'));
      onSent('התשובה נשלחה ותופיע לעובד בשיחה. הפנייה עברה ל"טופלו על ידי".');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'לא הצלחנו לשלוח את התשובה.');
      setSending(false);
    }
  };
  return <form className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div>
      <label htmlFor={inputId} className="block text-sm font-semibold text-slate-800">תשובה לעובד</label>
      <textarea id={inputId} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#137c77]"
        rows={4} maxLength={REP_REPLY_MAX} value={text} onChange={event => setText(event.target.value)} disabled={sending} dir="auto"
        aria-describedby={`${inputId}-hint`} required />
      <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-slate-500">
        פנייה כללית: התשובה תוצג לעובד בשיחה כהודעת נציג, ולא תשנה נתונים בפרופיל. עד {REP_REPLY_MAX.toLocaleString('he-IL')} תווים.
      </p>
    </div>
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{error}</p>}
    <div>
      <button type="submit" disabled={sending}
        className="inline-flex items-center rounded-lg bg-[#137c77] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0f6965] focus:outline-none focus:ring-2 focus:ring-[#137c77] focus:ring-offset-2 disabled:opacity-60">
        {sending ? <CarWiseCarLoader variant="button" label="בשליחה…" className="cw-on-dark" /> : 'שליחת התשובה'}
      </button>
    </div>
  </form>;
}

function AnswerForm({ request, field, onSent }: { request: Request; field: RequestableField; onSent: (message: string) => void }) {
  const spec = REQUESTABLE_FIELDS[field];
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const inputId = `value-${request.id}`;
  const submit = async () => {
    if (sending) return;
    const number = Number(value.replace(/[,\s₪%]/g, ''));
    const problem = value.trim() ? validateAnswerValue(field, number) : 'יש להזין ערך.';
    if (problem) { setError(problem); return; }
    setSending(true); setError('');
    try {
      const body = encodeRepAnswer({ kind: REP_ANSWER_KIND, requestId: request.id, field, value: number,
        ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}), answeredAt: new Date().toISOString() });
      const response = await fetch(`/api/conversations/${request.conversation_id}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ body, clientMessageId: crypto.randomUUID() })
      });
      if (!response.ok) throw new Error(await readError(response, 'לא הצלחנו לשלוח את התשובה.'));
      onSent(`התשובה על ${spec.label} נשלחה ונשמרה. הפנייה עברה ל"טופלו על ידי".`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'לא הצלחנו לשלוח את התשובה.');
      setSending(false);
    }
  };
  return <form className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div>
      <label htmlFor={inputId} className="block text-sm font-semibold text-slate-800">{spec.label}</label>
      <div className="mt-1.5 flex items-stretch overflow-hidden rounded-lg border border-slate-300 bg-white focus-within:ring-2 focus-within:ring-[#137c77]">
        <input id={inputId} className="w-full min-w-0 px-3 py-2.5 text-base outline-none" inputMode="decimal" dir="ltr" value={value}
          onChange={event => setValue(event.target.value)} disabled={sending} aria-describedby={`${inputId}-hint`} required />
        <span className="flex items-center border-r border-slate-200 bg-slate-100 px-3 text-sm text-slate-600">{spec.unit}</span>
      </div>
      <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-slate-500">
        טווח מותר: {spec.min.toLocaleString('he-IL')} עד {spec.max.toLocaleString('he-IL')}{spec.integer ? ', מספר שלם' : ''}
      </p>
    </div>
    <div>
      <label htmlFor={`${inputId}-note`} className="block text-sm font-semibold text-slate-800">הערה שתוצג בשיחה (לא חובה)</label>
      <textarea id={`${inputId}-note`} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#137c77]"
        rows={2} maxLength={300} value={note} onChange={event => setNote(event.target.value)} disabled={sending} />
    </div>
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200 sm:col-span-2">{error}</p>}
    <div className="sm:col-span-2">
      <button type="submit" disabled={sending}
        className="inline-flex items-center rounded-lg bg-[#137c77] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0f6965] focus:outline-none focus:ring-2 focus:ring-[#137c77] focus:ring-offset-2 disabled:opacity-60">
        {sending ? <CarWiseCarLoader variant="button" label="בשליחה…" className="cw-on-dark" /> : 'שליחת התשובה'}
      </button>
    </div>
  </form>;
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return <section aria-label={title} className="space-y-2">
    <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800">{title}<span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">{count}</span></h2>
    {count ? <ul className="space-y-2">{children}</ul> : <p className="rounded-xl bg-white px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">{empty}</p>}
  </section>;
}

/**
 * One compact request card. The summary is always visible; the details (ID reveal, answer form, sent answer) open
 * per card. The full-ID control is mounted only while the card is open, so collapsing a card also hides the ID; an
 * answer being typed is kept while the card is collapsed.
 */
export function RequestCard({ accent, header, action, toggleLabel, children, revealable }: {
  accent: string; header: React.ReactNode; action?: React.ReactNode; toggleLabel?: string; children?: React.ReactNode; revealable?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return <li className={`rounded-xl border-r-4 bg-white px-4 py-3 shadow-sm ring-1 ${accent}`}>
    {header}
    {(action || toggleLabel) && <div className="mt-2 flex flex-wrap items-center gap-2">
      {action}
      {toggleLabel && <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={detailsId}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-[#123f50] ring-1 ring-slate-200 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#137c77]">
        {open ? 'סגירה' : toggleLabel}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>}
    </div>}
    {toggleLabel && <div id={detailsId} hidden={!open} className="mt-3 border-t border-slate-100 pt-3">
      {open && revealable}
      {children}
    </div>}
  </li>;
}

export function RepresentativeConsole({ userId }: { userId: string }) {
  const refresh = useRef<AbortController | null>(null);
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  // A local clock keeps the waiting time current without asking the server again.
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<QueueFilter>({ query: '', view: 'all' });
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const load = useCallback(async () => {
    refresh.current?.abort();
    const controller = new AbortController();
    refresh.current = controller;
    setLoading(true); setError('');
    try {
      const data = await loadRepresentativeData(controller.signal);
      if (!controller.signal.aborted && refresh.current === controller) { setRequests(data.requests); setAnswers(data.answers); }
    } catch (failure) {
      if (!controller.signal.aborted && refresh.current === controller) setError(failure instanceof Error ? failure.message : 'לא הצלחנו לטעון את הפניות.');
    } finally { if (refresh.current === controller && !controller.signal.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 20000);
    return () => { window.clearInterval(timer); refresh.current?.abort(); };
  }, [load]);

  const claim = async (request: Request) => {
    setClaiming(request.id); setNotice('');
    try {
      const response = await fetch(`/api/representative-requests/${request.id}/claim`, { method: 'POST', cache: 'no-store' });
      setNotice(response.ok ? 'הפנייה הועברה לטיפולך.' : await readError(response, 'הפנייה כבר נלקחה או אינה זמינה.'));
    } catch {
      setNotice('לא הצלחנו לקחת את הפנייה לטיפול בגלל בעיית חיבור. יש לרענן ולבדוק את הסטטוס לפני ניסיון נוסף.');
    } finally { setClaiming(null); void load(); }
  };

  const visible = (request: Request) => matchesQuery(request, filter.query, fieldFromTopic(request.topic) ? REQUESTABLE_FIELDS[fieldFromTopic(request.topic)!].label : '');
  const allWaiting = requests?.filter(request => request.status === 'open' && !request.assigned_representative_id) ?? [];
  const allMine = requests?.filter(request => request.assigned_representative_id === userId && request.status === 'claimed') ?? [];
  const allDone = requests?.filter(request => request.assigned_representative_id === userId && request.status === 'answered') ?? [];
  const show = (view: QueueFilter['view']) => filter.view === 'all' || filter.view === view;
  const waiting = show('waiting') ? allWaiting.filter(visible) : [];
  const mine = show('mine') ? allMine.filter(visible) : [];
  const done = show('done') ? allDone.filter(visible) : [];
  const overdueCount = [...allWaiting, ...allMine].filter(request => isOverdue(request, now)).length;

  const setView = (view: QueueFilter['view']) => setFilter(current => ({ ...current, view }));
  const empty = (none: string) => filter.query ? 'אין פניות שמתאימות לחיפוש.' : none;

  return <div dir="rtl" className="space-y-5">
    <div className="space-y-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 sm:p-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="סינון לפי סטטוס">
        <StatusFilter label="הכול" value={requests ? allWaiting.length + allMine.length + allDone.length : null} tone="text-slate-700" active={filter.view === 'all'} onSelect={() => setView('all')} />
        <StatusFilter label="ממתינות" value={requests ? allWaiting.length : null} tone="text-amber-700" active={filter.view === 'waiting'} onSelect={() => setView('waiting')} />
        <StatusFilter label="בטיפולי" value={requests ? allMine.length : null} tone="text-sky-700" active={filter.view === 'mine'} onSelect={() => setView('mine')} />
        <StatusFilter label="טופלו על ידי" value={requests ? allDone.length : null} tone="text-emerald-700" active={filter.view === 'done'} onSelect={() => setView('done')} />
        {overdueCount > 0 && <p className="rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-800 ring-1 ring-rose-200" role="status">{overdueCount === 1 ? 'פנייה אחת ממתינה' : `${overdueCount} פניות ממתינות`} יותר מ־{OVERDUE_MINUTES} דקות</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="search">
        <label className="min-w-[200px] flex-1">
          <span className="sr-only">חיפוש לפי שם, תפקיד או שדה</span>
          <input type="search" dir="auto" value={filter.query} onChange={event => setFilter(current => ({ ...current, query: event.target.value }))}
            placeholder="חיפוש לפי שם, תפקיד או שדה" className="block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#137c77]" />
        </label>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-70">{loading ? <CarWiseCarLoader variant="button" label="מרעננים…" /> : 'רענון'}</button>
      </div>
      <p className="text-xs leading-relaxed text-amber-900"><span className="font-semibold">לתשומת לב:</span> יש לענות רק לפי מקור רשמי, כמו תלוש השכר או מערכת השכר. אם אין מקור כזה, עדיף להשאיר את הפנייה בטיפול ולא לשלוח הערכה.</p>
    </div>

    {notice && <p role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200">{notice}</p>}
    {error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">{error} <button className="font-semibold underline" onClick={() => void load()}>ניסיון חוזר</button></div>}
    {requests === null && loading && <div className="rounded-xl bg-white ring-1 ring-slate-200"><CarWiseCarLoader variant="representative" className="justify-center px-4 py-6" /></div>}

    {requests && <>
      {show('mine') && <Section title="בטיפולי" count={mine.length} empty={empty('אין כרגע פניות בטיפולך.')}>
        {mine.map(request => {
          const field = fieldFromTopic(request.topic);
          return <RequestCard key={request.id} accent={isOverdue(request, now) ? 'border-rose-500 ring-rose-200' : 'border-sky-500 ring-slate-200'}
            header={<RequestHeader request={request} field={field} now={now} pill={<Pill tone="mine">בטיפולי</Pill>} />}
            toggleLabel="מענה לפנייה"
            revealable={request.status === 'claimed' && request.assigned_representative_id === userId && <NationalIdReveal key={request.id} request={request} />}>
            {field ? <AnswerForm request={request} field={field} onSent={message => { setNotice(message); void load(); }} />
              : <GeneralReplyForm request={request} onSent={message => { setNotice(message); void load(); }} />}
          </RequestCard>;
        })}
      </Section>}

      {show('waiting') && <Section title="ממתינות לטיפול" count={waiting.length} empty={empty('אין כרגע פניות ממתינות.')}>
        {waiting.map(request => <RequestCard key={request.id} accent={isOverdue(request, now) ? 'border-rose-500 ring-rose-200' : 'border-amber-400 ring-slate-200'}
          header={<RequestHeader request={request} field={fieldFromTopic(request.topic)} now={now} pill={<Pill tone="waiting">ממתינה</Pill>} />}
          action={<button onClick={() => void claim(request)} disabled={claiming === request.id}
            className="inline-flex items-center rounded-lg bg-[#123f50] px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0f3542] focus:outline-none focus:ring-2 focus:ring-[#123f50] focus:ring-offset-2 disabled:opacity-70">
            {claiming === request.id ? <CarWiseCarLoader variant="button" label="מעבירים…" className="cw-on-dark" /> : 'העברה לטיפולי'}
          </button>} />)}
      </Section>}

      {show('done') && <Section title="טופלו על ידי" count={done.length} empty={empty('עדיין לא נשלחו תשובות.')}>
        {done.map(request => {
          const field = fieldFromTopic(request.topic);
          const answer = answers.get(request.id);
          return <RequestCard key={request.id} accent="border-emerald-500 ring-slate-200"
            header={<RequestHeader request={request} field={field} now={now} pill={<Pill tone="done">טופל על ידך</Pill>} />}
            toggleLabel="התשובה שנשלחה">
            <dl className="grid gap-2 rounded-lg bg-emerald-50/60 p-3 text-sm ring-1 ring-emerald-100 sm:grid-cols-3">
              <div className={answer?.kind === 'general' ? 'sm:col-span-2' : ''}><dt className="text-slate-600">התשובה שנשלחה</dt>
                <dd className="mt-0.5 whitespace-pre-line font-bold text-slate-900" dir="auto">{!answer ? '—' : answer.kind === 'field' ? formatAnswerValue(answer.field, answer.value) : answer.text}</dd></div>
              <div><dt className="text-slate-600">נשלחה</dt><dd className="mt-0.5 font-medium text-slate-900">{answer ? time(answer.answeredAt) : request.answered_at ? time(request.answered_at) : '—'}</dd></div>
              {answer?.kind === 'field' && answer.note && <div className="sm:col-span-3"><dt className="text-slate-600">הערה</dt><dd className="mt-0.5 leading-relaxed text-slate-900">{answer.note}</dd></div>}
            </dl>
            <p className="mt-2 text-xs text-slate-500">{field ? 'בשיחה תוצג אפשרות להשתמש בתשובה. היא תישמר בפרופיל רק אחרי אישור בסיכום.' : 'התשובה מוצגת לעובד בשיחה כהודעת נציג, ואינה משנה נתונים בפרופיל.'}</p>
          </RequestCard>;
        })}
      </Section>}
    </>}
  </div>;
}
