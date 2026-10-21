'use client';

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import {
  encodeRepAnswer, fieldFromTopic, formatAnswerValue, REP_ANSWER_KIND, REQUESTABLE_FIELDS, requestableFieldSchema,
  validateAnswerValue, type RequestableField
} from '../../lib/representative-answer';
import { isOverdue, matchesQuery, OVERDUE_MINUTES, waitingText, type QueueFilter } from '../../lib/representative-queue-view';

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
const answerSchema = z.object({ requestId: z.string().uuid(), field: requestableFieldSchema, value: z.number(), note: z.string().optional(), answeredAt: z.string() });
type Request = z.infer<typeof requestSchema>;
type Answer = z.infer<typeof answerSchema>;
const time = (value: string) => new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));

async function readError(response: Response, fallback: string) {
  try { const data = await response.json(); return typeof data.error === 'string' ? data.error : fallback; } catch { return fallback; }
}

function Pill({ tone, children }: { tone: 'waiting' | 'mine' | 'done'; children: React.ReactNode }) {
  const tones = { waiting: 'bg-amber-50 text-amber-800 ring-amber-200', mine: 'bg-sky-50 text-sky-800 ring-sky-200', done: 'bg-emerald-50 text-emerald-800 ring-emerald-200' };
  return <span className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tones[tone]}`}>{children}</span>;
}

function Metric({ label, value, tone }: { label: string; value: number | null; tone: string }) {
  return <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
    <p className="text-sm font-medium text-slate-600">{label}</p>
    <p className={`mt-2 text-3xl font-bold tabular-nums ${tone}`}>{value ?? '–'}</p>
  </div>;
}

export function RequestHeader({ request, field, pill, now }: { request: Request; field: RequestableField | null; pill: React.ReactNode; now: number }) {
  const overdue = isOverdue(request, now);
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {/* The account's stored name, read on the server. A missing name means the identity record does not exist yet. */}
        <p className="text-base font-bold text-slate-900">{request.employee_name
          ? <bdi>{request.employee_name}</bdi>
          : <span className="font-semibold text-slate-500">שם לא זמין (פרטי הזהות עוד לא נשמרו)</span>}
          {request.occupation && <span className="font-normal text-slate-600"> · <bdi>{request.occupation}</bdi></span>}
          {request.employee_id_last4 && <span className="font-normal text-slate-600"> · ת״ז <bdi dir="ltr">•••••{request.employee_id_last4}</bdi></span>}</p>
        <h3 className="mt-1 text-lg font-bold leading-snug text-[#123f50]">{field ? REQUESTABLE_FIELDS[field].label : 'פנייה כללית'}</h3>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {overdue && <span className="inline-flex items-center rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-800 ring-1 ring-rose-200">מעל {OVERDUE_MINUTES} דקות</span>}
        {pill}
      </div>
    </div>
    <p className="mt-2 leading-relaxed text-slate-800">{field ? REQUESTABLE_FIELDS[field].question : request.topic ?? 'ללא נושא'}</p>
    <p className="mt-2 text-xs text-slate-500">מספר פנייה <bdi>#{request.id.slice(0, 6)}</bdi> · נפתחה <time dateTime={request.requested_at}>{time(request.requested_at)}</time>
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
  return <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
    {state.kind === 'shown'
      ? <><span className="rounded-lg bg-slate-100 px-3 py-1.5 font-semibold text-slate-900 ring-1 ring-slate-200">ת״ז מלאה: <bdi dir="ltr">{state.id}</bdi></span>
        <button type="button" onClick={() => setState({ kind: 'hidden' })} className="font-semibold text-[#123f50] underline">הסתרה</button></>
      : <button type="button" onClick={() => void reveal()} disabled={state.kind === 'loading'}
          className="rounded-lg bg-white px-3 py-1.5 font-semibold text-[#123f50] ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60">
          {state.kind === 'loading' ? 'רגע…' : 'הצגת ת״ז מלאה'}</button>}
    {state.kind === 'error' && <span role="alert" className="text-rose-700">לא ניתן להציג את הפרט כרגע.</span>}
    <span className="text-xs text-slate-500">זמין רק בזמן שהפנייה בטיפולך. כל הצגה נרשמת.</span>
  </div>;
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
  return <form className="mt-5 grid gap-4 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
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
        className="rounded-lg bg-[#137c77] px-5 py-2.5 font-semibold text-white shadow-sm transition hover:bg-[#0f6965] focus:outline-none focus:ring-2 focus:ring-[#137c77] focus:ring-offset-2 disabled:opacity-60">
        {sending ? 'בשליחה…' : 'שליחת התשובה'}
      </button>
    </div>
  </form>;
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return <section aria-label={title} className="space-y-3">
    <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">{title}<span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-700">{count}</span></h2>
    {count ? <ul className="space-y-3">{children}</ul> : <p className="rounded-2xl bg-white p-5 text-sm text-slate-600 ring-1 ring-slate-200">{empty}</p>}
  </section>;
}

export function RepresentativeConsole({ userId }: { userId: string }) {
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
    setLoading(true); setError('');
    try {
      const [queue, sent] = await Promise.all([
        fetch('/api/representative-requests', { cache: 'no-store' }),
        fetch('/api/representative-requests/answers', { cache: 'no-store' })
      ]);
      if (!queue.ok) throw new Error(await readError(queue, 'לא הצלחנו לטעון את הפניות.'));
      const data = z.object({ requests: z.array(requestSchema.passthrough()) }).parse(await queue.json());
      setRequests(data.requests.map(request => requestSchema.parse(request)).sort((a, b) => a.requested_at.localeCompare(b.requested_at)));
      if (sent.ok) setAnswers(new Map(z.object({ answers: z.array(answerSchema) }).parse(await sent.json()).answers.map(answer => [answer.requestId, answer])));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'לא הצלחנו לטעון את הפניות.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  const claim = async (request: Request) => {
    setClaiming(request.id); setNotice('');
    try {
      const response = await fetch(`/api/representative-requests/${request.id}/claim`, { method: 'POST', cache: 'no-store' });
      setNotice(response.ok ? 'הפנייה הועברה לטיפולך.' : await readError(response, 'הפנייה כבר נלקחה או אינה זמינה.'));
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

  return <div dir="rtl" className="space-y-8">
    <div className="grid gap-4 sm:grid-cols-3" aria-live="polite">
      <Metric label="ממתינות" value={requests ? allWaiting.length : null} tone="text-amber-700" />
      <Metric label="בטיפולי" value={requests ? allMine.length : null} tone="text-sky-700" />
      <Metric label="טופלו על ידי" value={requests ? allDone.length : null} tone="text-emerald-700" />
    </div>

    <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
      <p className="min-w-0 flex-1">יש לענות רק לפי מקור רשמי, כמו תלוש השכר או מערכת השכר. אם אין מקור כזה, עדיף להשאיר את הפנייה בטיפול ולא לשלוח הערכה.</p>
      <button onClick={() => void load()} disabled={loading}
        className="rounded-lg bg-white px-3 py-1.5 font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60">{loading ? 'בטעינה…' : 'רענון'}</button>
    </div>

    {requests && <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" role="search">
      <label className="min-w-[200px] flex-1 text-sm font-semibold text-slate-800">חיפוש
        <input type="search" value={filter.query} onChange={event => setFilter(current => ({ ...current, query: event.target.value }))}
          placeholder="שם, תפקיד או שדה" className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base font-normal outline-none focus:ring-2 focus:ring-[#137c77]" />
      </label>
      <label className="text-sm font-semibold text-slate-800">סטטוס
        <select value={filter.view} onChange={event => setFilter(current => ({ ...current, view: event.target.value as QueueFilter['view'] }))}
          className="mt-1.5 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-base font-normal outline-none focus:ring-2 focus:ring-[#137c77]">
          <option value="all">הכול</option><option value="waiting">ממתינות לטיפול</option><option value="mine">בטיפולי</option><option value="done">טופלו על ידי</option>
        </select>
      </label>
      {overdueCount > 0 && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800 ring-1 ring-rose-200" role="status">{overdueCount === 1 ? 'פנייה אחת ממתינה' : `${overdueCount} פניות ממתינות`} יותר מ־{OVERDUE_MINUTES} דקות</p>}
    </div>}

    {notice && <p role="status" className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900 ring-1 ring-emerald-200">{notice}</p>}
    {error && <div role="alert" className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200">{error} <button className="font-semibold underline" onClick={() => void load()}>ניסיון חוזר</button></div>}
    {requests === null && loading && <p role="status" className="rounded-2xl bg-white p-6 text-slate-600 ring-1 ring-slate-200">הפניות בטעינה…</p>}

    {requests && <>
      {show('mine') && <Section title="בטיפולי" count={mine.length} empty={filter.query ? 'אין פניות שמתאימות לחיפוש.' : 'אין כרגע פניות בטיפולך.'}>
        {mine.map(request => {
          const field = fieldFromTopic(request.topic);
          return <li key={request.id} className={`rounded-2xl border-r-4 bg-white p-5 shadow-sm ring-1 ${isOverdue(request, now) ? 'border-rose-500 ring-rose-200' : 'border-sky-500 ring-slate-200'}`}>
            <RequestHeader request={request} field={field} now={now} pill={<Pill tone="mine">בטיפולי</Pill>} />
            {request.status === 'claimed' && request.assigned_representative_id === userId && <NationalIdReveal key={request.id} request={request} />}
            {field ? <AnswerForm request={request} field={field} onSent={message => { setNotice(message); void load(); }} />
              : <p className="mt-3 text-sm text-amber-800">בפנייה הזו אין שדה חסר מוגדר, ולכן אין כאן טופס תשובה מובנה.</p>}
          </li>;
        })}
      </Section>}

      {show('waiting') && <Section title="ממתינות לטיפול" count={waiting.length} empty={filter.query ? 'אין פניות שמתאימות לחיפוש.' : 'אין כרגע פניות ממתינות.'}>
        {waiting.map(request => <li key={request.id} className={`rounded-2xl border-r-4 bg-white p-5 shadow-sm ring-1 ${isOverdue(request, now) ? 'border-rose-500 ring-rose-200' : 'border-amber-400 ring-slate-200'}`}>
          <RequestHeader request={request} field={fieldFromTopic(request.topic)} now={now} pill={<Pill tone="waiting">ממתינה</Pill>} />
          <button onClick={() => void claim(request)} disabled={claiming === request.id}
            className="mt-4 rounded-lg bg-[#123f50] px-5 py-2.5 font-semibold text-white shadow-sm transition hover:bg-[#0f3542] focus:outline-none focus:ring-2 focus:ring-[#123f50] focus:ring-offset-2 disabled:opacity-60">
            {claiming === request.id ? 'רגע…' : 'העברה לטיפולי'}
          </button>
        </li>)}
      </Section>}

      {show('done') && <Section title="טופלו על ידי" count={done.length} empty={filter.query ? 'אין פניות שמתאימות לחיפוש.' : 'עדיין לא נשלחו תשובות.'}>
        {done.map(request => {
          const field = fieldFromTopic(request.topic);
          const answer = answers.get(request.id);
          return <li key={request.id} className="rounded-2xl border-r-4 border-emerald-500 bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <RequestHeader request={request} field={field} now={now} pill={<Pill tone="done">טופל על ידך</Pill>} />
            <dl className="mt-4 grid gap-3 rounded-xl bg-emerald-50/60 p-4 text-sm ring-1 ring-emerald-100 sm:grid-cols-3">
              <div><dt className="text-slate-600">התשובה שנשלחה</dt><dd className="mt-0.5 text-base font-bold text-slate-900">{answer ? formatAnswerValue(answer.field, answer.value) : '—'}</dd></div>
              <div><dt className="text-slate-600">נשלחה</dt><dd className="mt-0.5 font-medium text-slate-900">{answer ? time(answer.answeredAt) : request.answered_at ? time(request.answered_at) : '—'}</dd></div>
              {answer?.note && <div className="sm:col-span-3"><dt className="text-slate-600">הערה</dt><dd className="mt-0.5 leading-relaxed text-slate-900">{answer.note}</dd></div>}
            </dl>
            <p className="mt-3 text-xs text-slate-500">בשיחה תוצג אפשרות להשתמש בתשובה. היא תישמר בפרופיל רק אחרי אישור בסיכום.</p>
          </li>;
        })}
      </Section>}
    </>}
  </div>;
}
