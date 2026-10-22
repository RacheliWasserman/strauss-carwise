'use client';

import { useEffect, useRef, useState } from 'react';
import {
  encodePayslipReview, extractionResponseSchema, PAYSLIP_ACCEPT, PAYSLIP_FIELD_ORDER, PAYSLIP_LIMITS, VISION_CONSENT_TEXT, VISION_CONSENT_VERSION,
  type PayslipReview
} from '@/lib/payslip/payslip-contract';
import { buildPayslipReview, initialReviewRows, reviewRowError, type ExtractedResult as Extracted, type ReviewRows } from '@/lib/payslip/payslip-review-form';
import { ChatIcon } from './chat-icon';
import { CarWiseCarLoader } from '../ui/carwise-car-loader';
import { PayslipReviewRow } from './payslip-review-row';

type Stage =
  | { kind: 'pick' }
  | { kind: 'reading'; vision: boolean }
  | { kind: 'consent'; reason: 'image' | 'scanned_pdf' | 'no_fields'; available: boolean }
  | { kind: 'review'; result: Extracted | null }
  | { kind: 'error'; message: string; ref?: string; retry?: boolean };

const REASON: Record<'image' | 'scanned_pdf' | 'no_fields', string> = {
  image: 'זו תמונה, ולכן אפשר לקרוא אותה רק בקריאה חזותית.',
  scanned_pdf: 'נראה שזה תלוש סרוק (תמונה בתוך PDF), ולכן אפשר לקרוא אותו רק בקריאה חזותית.',
  no_fields: 'לא מצאתי בטקסט של הקובץ נתוני שכר. קריאה חזותית עשויה לזהות אותם.'
};
const METHOD: Record<Extracted['method'], string> = { pdf_text: 'נקרא מקובץ PDF דיגיטלי, אצלנו בלבד', docx: 'נקרא מקובץ Word, אצלנו בלבד', vision: 'נקרא בקריאה חזותית (Google Gemini)' };

/**
 * Payslip upload and review. In the chat the reviewed values become a message for the approval summary; on the
 * profile page they fill the profile form. In both, nothing is saved before the employee's own explicit approval.
 */
export function PayslipUpload({ endpoint, destination = 'chat', busy = false, onSubmit, onClose }: {
  /** The upload route: the conversation's own, or the profile's. */
  endpoint: string; destination?: 'chat' | 'profile'; busy?: boolean;
  /** The reviewed values, and the same values encoded as the chat message. */
  onSubmit: (review: PayslipReview, encoded: string) => void; onClose: () => void;
}) {
  const profile = destination === 'profile';
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [consent, setConsent] = useState(false);
  const [rows, setRows] = useState<ReviewRows>(() => initialReviewRows(null));
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { request.current?.abort(); };
  }, []);
  // The file and the extraction live only in this dialog; closing it drops both.
  const close = () => { request.current?.abort(); setFile(null); onClose(); };

  const toReview = (result: Extracted | null) => {
    // On the profile page the page itself is the manual form.
    if (profile && !result) { close(); return; }
    setRows(initialReviewRows(result));
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
      const response = await fetch(endpoint, { method: 'POST', body: form, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const data: unknown = await response.json().catch(() => null);
      // A newer upload replaced this one: its answer must not overwrite the newer review.
      if (request.current !== controller) return;
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
    if (PAYSLIP_FIELD_ORDER.some(field => reviewRowError(field, rows[field]))) { setFormError('יש לתקן את השדות המסומנים.'); return; }
    const review = buildPayslipReview(result, rows);
    if (!review) { setFormError('יש למלא לפחות ערך אחד או לסמן "לא ידוע".'); return; }
    onSubmit(review, encodePayslipReview(review));
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
      <button type="button" className="cw-payslip-link" onClick={() => toReview(null)}>{profile ? 'חזרה למילוי ידני' : 'הזנה ידנית במקום העלאה'}</button>
    </div>}

    {stage.kind === 'reading' && <div className="cw-payslip-body cw-payslip-center">
      <CarWiseCarLoader variant="payslip" /><p className="cw-payslip-reading-note">{stage.vision ? 'קריאה חזותית של התלוש. זה עשוי לקחת כמה שניות.' : 'הקובץ נקרא אצלנו, בלי שירות חיצוני.'}</p>
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
      {stage.result ? <p className="cw-payslip-lead">{METHOD[stage.result.method]}. כדאי לבדוק כל ערך, לתקן אם צריך, או לסמן "לא ידוע". {profile ? 'שדה ריק או "לא ידוע" לא ישנה את הערך שבטופס.' : 'שדה ריק יישאל בהמשך השיחה.'}</p>
        : <p className="cw-payslip-lead">אפשר להזין את הערכים כפי שהם מופיעים בתלוש. שדה ריק יישאל בהמשך השיחה.</p>}
      {stage.result?.warnings.map(warning => <p key={warning} className="cw-payslip-note">{warning}</p>)}
      <ul className="cw-payslip-rows">{PAYSLIP_FIELD_ORDER.map(field => <PayslipReviewRow key={field} field={field} result={stage.result} row={rows[field]}
        onChange={patch => setRows(current => ({ ...current, [field]: { ...current[field], ...patch } }))} />)}</ul>
      {formError && <p className="cw-payslip-error" role="alert">{formError}</p>}
      <p className="cw-payslip-note">{profile ? 'הערכים יועברו לטופס הפרופיל לבדיקה. שום דבר לא יישמר ולא ישמש לחישוב עד שתלחצו על "שמירת הפרופיל".'
        : 'הערכים ייכנסו לסיכום לאישור בצ׳אט. שום דבר לא יישמר בפרופיל ולא ישמש לחישוב לפני אישור הסיכום.'}</p>
      <div className="cw-payslip-actions">
        <button type="submit" className="cw-payslip-primary">{profile ? 'העברה לטופס הפרופיל' : 'העברה לסיכום לאישור'}</button>
        <button type="button" onClick={close}>ביטול</button>
      </div>
    </form>}
  </dialog>;
}
