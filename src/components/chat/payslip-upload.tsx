'use client';

import { useEffect, useRef, useState } from 'react';
import {
  encodePayslipReview, extractionResponseSchema, PAYSLIP_ACCEPT, PAYSLIP_FIELD_ORDER, PAYSLIP_FIELDS, PAYSLIP_LIMITS,
  PAYSLIP_REVIEW_KIND, VISION_CONSENT_TEXT, VISION_CONSENT_VERSION, type ExtractionResponse, type PayslipField, type PayslipReview
} from '@/lib/payslip/payslip-contract';
import { ChatIcon } from './chat-icon';

type Extracted = Extract<ExtractionResponse, { status: 'extracted' }>;
type Stage =
  | { kind: 'pick' }
  | { kind: 'reading'; vision: boolean }
  | { kind: 'consent'; reason: 'image' | 'scanned_pdf' | 'no_fields'; available: boolean }
  | { kind: 'review'; result: Extracted | null }
  | { kind: 'error'; message: string; ref?: string; retry?: boolean };
type Row = { input: string; unknown: boolean };

const REASON: Record<'image' | 'scanned_pdf' | 'no_fields', string> = {
  image: 'זו תמונה, ולכן אפשר לקרוא אותה רק בקריאה חזותית.',
  scanned_pdf: 'נראה שזה תלוש סרוק (תמונה בתוך PDF), ולכן אפשר לקרוא אותו רק בקריאה חזותית.',
  no_fields: 'לא מצאתי בטקסט של הקובץ נתוני שכר. קריאה חזותית עשויה לזהות אותם.'
};
const METHOD: Record<Extracted['method'], string> = { pdf_text: 'נקרא מקובץ PDF דיגיטלי, אצלנו בלבד', docx: 'נקרא מקובץ Word, אצלנו בלבד', vision: 'נקרא בקריאה חזותית (Google Gemini)' };

/** "15,000" / "6.5%" / "₪ 900" → a number; empty → null; anything else → NaN. */
function parseInput(text: string) {
  const clean = text.replace(/[,\s₪%]/g, '');
  if (!clean) return null;
  return /^\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}
function rowError(field: PayslipField, row: Row) {
  if (row.unknown) return null;
  const value = parseInput(row.input);
  if (value === null) return null;
  if (Number.isNaN(value)) return 'יש להזין מספר.';
  if (value > PAYSLIP_FIELDS[field].max) return 'הערך גבוה מדי.';
  if (field === 'base_salary' && value < 1000) return 'יש להזין שכר חודשי מלא בשקלים.';
  return null;
}

export function PayslipUpload({ conversationId, busy, onSubmit, onClose }: {
  conversationId: string; busy: boolean; onSubmit: (body: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [consent, setConsent] = useState(false);
  const [rows, setRows] = useState<Record<PayslipField, Row>>(() => Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, { input: '', unknown: false }])) as Record<PayslipField, Row>);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { request.current?.abort(); };
  }, []);
  // The file and the extraction live only in this dialog; closing it drops both.
  const close = () => { request.current?.abort(); setFile(null); onClose(); };

  const toReview = (result: Extracted | null) => {
    setRows(Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => {
      const value = result?.fields.find(item => item.field === field)?.value;
      return [field, { input: value === null || value === undefined ? '' : String(value), unknown: false }];
    })) as Record<PayslipField, Row>);
    setFormError(null);
    setStage({ kind: 'review', result });
  };

  const upload = async (chosen: File, withConsent: boolean) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 75_000);
    setStage({ kind: 'reading', vision: withConsent });
    try {
      const form = new FormData();
      form.append('file', chosen);
      if (withConsent) form.append('consent', VISION_CONSENT_VERSION);
      const response = await fetch(`/api/conversations/${conversationId}/payslip`, { method: 'POST', body: form, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const message = typeof record.error === 'string' ? record.error : 'לא הצלחתי לעבד את הקובץ כרגע.';
        const ref = typeof record.ref === 'string' && /^[a-f0-9]{8}$/.test(record.ref) ? record.ref : undefined;
        // A temporary provider problem may be retried with the same file and the consent already given for it.
        const retry = withConsent && ['vision_busy', 'vision_timeout', 'vision_unavailable'].includes(String(record.code));
        setStage({ kind: 'error', message: response.status === 401 ? 'כדי להמשיך, צריך להתחבר שוב.' : message, ref, retry });
        return;
      }
      const parsed = extractionResponseSchema.safeParse(data);
      if (!parsed.success) { setStage({ kind: 'error', message: 'התקבלה תשובה לא צפויה. אפשר לנסות שוב או להזין ידנית.' }); return; }
      if (parsed.data.status === 'needs_vision') { setConsent(false); setStage({ kind: 'consent', reason: parsed.data.reason, available: parsed.data.visionAvailable }); return; }
      toReview(parsed.data);
    } catch {
      if (request.current === controller) setStage({ kind: 'error', message: controller.signal.aborted ? 'העיבוד ארך יותר מדי. אפשר לנסות שוב או להזין ידנית.' : 'משהו השתבש בחיבור. אפשר לנסות שוב.' });
    } finally { window.clearTimeout(timer); }
  };

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    if (chosen.size > PAYSLIP_LIMITS.maxBytes) { setStage({ kind: 'error', message: 'הקובץ גדול מדי. אפשר להעלות קובץ עד 4MB.' }); return; }
    setFile(chosen);
    void upload(chosen, false);
  };

  const submit = () => {
    if (busy) { setFormError('רגע, CarWise עדיין עונה להודעה הקודמת. אפשר לנסות שוב בעוד רגע.'); return; }
    const result = stage.kind === 'review' ? stage.result : null;
    if (PAYSLIP_FIELD_ORDER.some(field => rowError(field, rows[field]))) { setFormError('יש לתקן את השדות המסומנים.'); return; }
    const values: PayslipReview['values'] = {};
    for (const field of PAYSLIP_FIELD_ORDER) {
      const row = rows[field];
      const value = parseInput(row.input);
      if (row.unknown) values[field] = 'unknown';
      else if (value !== null && !Number.isNaN(value)) values[field] = value;
    }
    if (!Object.keys(values).length) { setFormError('יש למלא לפחות ערך אחד או לסמן "לא ידוע".'); return; }
    const extracted = Object.fromEntries(PAYSLIP_FIELD_ORDER.map(field => [field, result?.fields.find(item => item.field === field)?.value ?? null])) as PayslipReview['extracted'];
    const body = encodePayslipReview(result
      ? { kind: PAYSLIP_REVIEW_KIND, method: result.method, extracted, values, token: result.token, expiresAt: result.expiresAt }
      : { kind: PAYSLIP_REVIEW_KIND, method: 'manual', extracted, values });
    onSubmit(body);
    close();
  };

  const title = stage.kind === 'review' ? (stage.result ? 'בדיקת הנתונים מהתלוש' : 'הזנת פרטי שכר') : 'העלאת תלוש שכר';
  return <dialog ref={dialog} className="cw-payslip" dir="rtl" aria-labelledby="cw-payslip-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="cw-payslip-header">
      <span className="cw-payslip-icon"><ChatIcon name="document" /></span>
      <h2 id="cw-payslip-title">{title}</h2>
      <button type="button" className="cw-icon-button" aria-label="סגירה" onClick={close}><ChatIcon name="close" /></button>
    </header>

    {stage.kind === 'pick' && <div className="cw-payslip-body">
      <p>אפשר להעלות תלוש שכר, ו־CarWise יציע את הנתונים הדרושים לחישוב. כל ערך נבדק ומאושר בטופס לפני שהוא נכנס לפרופיל.</p>
      <label className="cw-payslip-drop">
        <input type="file" accept={PAYSLIP_ACCEPT} onChange={event => choose(event.target.files?.[0])} />
        <ChatIcon name="upload" /><strong>בחירת קובץ</strong><span>PDF, JPG, PNG, WEBP או DOCX · עד 4MB</span>
      </label>
      <ul className="cw-payslip-facts">
        <li><ChatIcon name="shield" />הקובץ לא נשמר: לא בשרת, לא בשיחה ולא בהיסטוריה.</li>
        <li><ChatIcon name="check" />PDF דיגיטלי ו־DOCX נקראים אצלנו בלבד.</li>
        <li><ChatIcon name="spark" />תמונות ותלושים סרוקים נשלחים לקריאה חזותית ב־Google Gemini, רק אחרי אישור מפורש.</li>
        <li><ChatIcon name="document" />נלקחים רק 7 נתוני שכר. שם, ת״ז ופרטי בנק לא נאספים.</li>
      </ul>
      <button type="button" className="cw-payslip-link" onClick={() => toReview(null)}>הזנה ידנית במקום העלאה</button>
    </div>}

    {stage.kind === 'reading' && <div className="cw-payslip-body cw-payslip-center" role="status">
      <i className="cw-spinner" /><p>{stage.vision ? 'התלוש נקרא בקריאה חזותית…' : 'הקובץ נקרא…'}</p>
    </div>}

    {stage.kind === 'consent' && <div className="cw-payslip-body">
      <p className="cw-payslip-lead">{REASON[stage.reason]}</p>
      {stage.available ? <>
        <div className="cw-payslip-consent">
          <h3>לפני שליחה לשירות חיצוני</h3>
          <ul>
            <li>הקובץ יישלח לשירות <strong>Google Gemini</strong> בלבד, בלי היסטוריית השיחה ובלי פרטים אישיים נוספים. אם השירות עמוס, אותו קובץ יישלח שוב לאותו שירות עד פעמיים.</li>
            <li>תמונה מוקטנת ונשלחת מחדש כ־JPEG בלי המידע הנלווה (כמו מיקום, תאריך ודגם המצלמה). קובץ PDF סרוק נשלח כפי שהוא, כולל המידע הנלווה שבו.</li>
            <li>השירות פועל בתנאי השימוש של Google, ובחשבון ללא תשלום Google רשאית להשתמש בתוכן לשיפור שירותיה.</li>
            <li><strong>בשלב הניסיון של המערכת יש להעלות לקריאה חזותית רק תלוש לדוגמה, ולא תלוש אמיתי.</strong></li>
          </ul>
          <label className="cw-payslip-check">
            <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
            <span>{VISION_CONSENT_TEXT}</span>
          </label>
        </div>
        <div className="cw-payslip-actions">
          <button type="button" className="cw-payslip-primary" disabled={!consent || !file} onClick={() => file && void upload(file, true)}>שליחה לקריאה חזותית</button>
          <button type="button" onClick={() => toReview(null)}>הזנה ידנית במקום</button>
        </div>
      </> : <>
        <p className="cw-payslip-note">קריאה חזותית לא זמינה כרגע. אפשר להעלות PDF דיגיטלי או DOCX, או להזין את הפרטים ידנית.</p>
        <div className="cw-payslip-actions">
          <button type="button" className="cw-payslip-primary" onClick={() => toReview(null)}>הזנה ידנית</button>
          <button type="button" onClick={() => { setFile(null); setStage({ kind: 'pick' }); }}>קובץ אחר</button>
        </div>
      </>}
    </div>}

    {stage.kind === 'error' && <div className="cw-payslip-body">
      <p className="cw-payslip-error" role="alert">{stage.message}</p>
      {stage.ref && <p className="cw-payslip-note">קוד לבירור: <bdi dir="ltr">{stage.ref}</bdi></p>}
      <div className="cw-payslip-actions">
        {stage.retry && file && <button type="button" className="cw-payslip-primary" onClick={() => void upload(file, true)}>ניסיון חוזר (שליחה חוזרת ל־Gemini)</button>}
        <button type="button" className={stage.retry && file ? '' : 'cw-payslip-primary'} onClick={() => toReview(null)}>הזנה ידנית</button>
        <button type="button" onClick={() => { setFile(null); setStage({ kind: 'pick' }); }}>קובץ אחר</button>
      </div>
    </div>}

    {stage.kind === 'review' && <form className="cw-payslip-body" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
      {stage.result ? <p className="cw-payslip-lead">{METHOD[stage.result.method]}. כדאי לבדוק כל ערך, לתקן אם צריך, או לסמן "לא ידוע". שדה ריק יישאל בהמשך השיחה.</p>
        : <p className="cw-payslip-lead">אפשר להזין את הערכים כפי שהם מופיעים בתלוש. שדה ריק יישאל בהמשך השיחה.</p>}
      {stage.result?.warnings.map(warning => <p key={warning} className="cw-payslip-note">{warning}</p>)}
      <ul className="cw-payslip-rows">{PAYSLIP_FIELD_ORDER.map(field => {
        const spec = PAYSLIP_FIELDS[field];
        const found = stage.result?.fields.find(item => item.field === field);
        const row = rows[field];
        const error = rowError(field, row);
        const value = parseInput(row.input);
        const edited = Boolean(stage.result) && !row.unknown && value !== null && !Number.isNaN(value) && value !== (found?.value ?? null);
        const state = !stage.result ? 'manual' : row.unknown ? 'unknown' : found?.value === null || found?.value === undefined ? 'missing' : found.confidence === 'high' ? 'found' : 'review';
        const badge = { manual: '', unknown: 'לא ידוע', missing: 'לא נמצא', found: 'זוהה בתלוש', review: 'לבדיקה' }[state];
        const id = `cw-payslip-${field}`;
        return <li key={field} className={`cw-payslip-row cw-payslip-row-${state}`}>
          <div className="cw-payslip-row-head">
            <label htmlFor={id}>{spec.label}</label>
            {badge && <span className="cw-payslip-badge">{edited ? (found?.value === null || found?.value === undefined ? 'הוזן על ידך' : 'תוקן על ידך') : badge}</span>}
          </div>
          <div className="cw-payslip-field">
            <input id={id} inputMode="decimal" dir="ltr" autoComplete="off" value={row.unknown ? '' : row.input} disabled={row.unknown}
              placeholder={row.unknown ? 'לא ידוע' : 'ריק'} aria-invalid={Boolean(error)} aria-describedby={`${id}-help`}
              onChange={event => setRows(current => ({ ...current, [field]: { ...current[field], input: event.target.value } }))} />
            <span className="cw-payslip-unit">{spec.unit}</span>
            <label className="cw-payslip-unknown">
              <input type="checkbox" checked={row.unknown} onChange={event => setRows(current => ({ ...current, [field]: { ...current[field], unknown: event.target.checked } }))} />
              <span>לא ידוע</span>
            </label>
          </div>
          <div id={`${id}-help`} className="cw-payslip-help">
            {error && <p className="cw-payslip-row-error">{error}</p>}
            {found?.evidence && <p className="cw-payslip-source">מקור: {found.page ? `עמוד ${found.page} · ` : ''}<bdi>{found.evidence}</bdi></p>}
            {found?.warnings.map(warning => <p key={warning} className="cw-payslip-warning">{warning}</p>)}
          </div>
        </li>;
      })}</ul>
      {formError && <p className="cw-payslip-error" role="alert">{formError}</p>}
      <p className="cw-payslip-note">הערכים ייכנסו לסיכום לאישור בצ׳אט. שום דבר לא יישמר בפרופיל ולא ישמש לחישוב לפני אישור הסיכום.</p>
      <div className="cw-payslip-actions">
        <button type="submit" className="cw-payslip-primary">העברה לסיכום לאישור</button>
        <button type="button" onClick={close}>ביטול</button>
      </div>
    </form>}
  </dialog>;
}
