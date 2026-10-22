'use client';

import { useLayoutEffect, type RefObject } from 'react';
import { ChatIcon } from './chat-icon';

type Props = {
  value: string; onChange: (value: string) => void; onSubmit: () => void;
  sending: boolean; pending: boolean; disabled: boolean; error: string | null;
  /** A reply is on its way: the next message can be written but not sent yet. */
  waiting?: boolean;
  needsLogin: boolean; textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Opens the payslip upload; available once a conversation exists. */
  onPayslip?: () => void; payslipDisabled?: boolean;
};

export function ChatComposer(props: Props) {
  useLayoutEffect(() => {
    const input = props.textareaRef.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
  }, [props.value, props.textareaRef]);

  return <div className="cw-composer-region">
    {props.error && <div className="cw-send-error" role="alert"><span>{props.error}</span>{props.needsLogin && <a href="/login">להתחברות מחדש</a>}</div>}
    <form className={`cw-composer ${props.pending ? 'cw-composer-pending' : ''}`} onSubmit={event => { event.preventDefault(); props.onSubmit(); }}>
      <label className="cw-sr-only" htmlFor="cw-message">ההודעה שלך ל־CarWise</label>
      <textarea id="cw-message" ref={props.textareaRef} value={props.value} rows={1} maxLength={16000}
        placeholder="מה תרצו לדעת? מתחילים בהודעה אחת…" dir="auto" autoComplete="off"
        readOnly={props.pending} disabled={props.disabled} aria-describedby="cw-composer-help"
        onChange={event => props.onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (!props.disabled && !props.waiting && !props.sending && props.value.trim()) event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="cw-composer-bottom">{props.onPayslip && <button type="button" className="cw-payslip-open" aria-label="העלאת תלוש שכר" onClick={props.onPayslip}
          disabled={props.payslipDisabled} title={props.payslipDisabled ? 'אפשר להעלות תלוש אחרי שמתחילים שיחה' : undefined}>
          <ChatIcon name="document" /><span>העלאת תלוש שכר</span></button>}<span><ChatIcon name={props.pending ? 'clock' : 'spark'} />{props.sending ? 'ההודעה נשמרת…' : props.pending ? 'ההודעה ממתינה לאישור שמירה' : props.waiting ? 'התשובה בדרך · אפשר כבר לכתוב' : 'המקום לשאלות שלך'}</span>
        <button className="cw-send" type="submit" disabled={props.disabled || props.waiting || props.sending || !props.value.trim()} aria-label={props.pending ? 'ניסיון שליחה חוזר ללא כפילות' : 'שליחת הודעה'}>
          <span>{props.sending ? 'בשמירה' : props.pending ? 'ניסיון חוזר' : 'שליחה'}</span>{props.sending ? <i className="cw-spinner" aria-hidden="true" /> : <ChatIcon name={props.pending ? 'retry' : 'arrow'} />}
        </button>
      </div>
    </form>
    <div className="cw-composer-help" id="cw-composer-help"><span>Enter לשליחה <i /> Shift + Enter לשורה חדשה</span><span>{props.value.length > 14500 ? `${props.value.length.toLocaleString('he-IL')} / 16,000` : 'ההודעות נשמרות בחשבון שלך'}</span></div>
  </div>;
}
