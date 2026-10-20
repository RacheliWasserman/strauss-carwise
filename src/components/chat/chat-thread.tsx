'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, OutgoingMessage } from '@/lib/chat-client';
import { CarWiseMark, ChatIcon } from './chat-icon';
import { decodeCatalogMessage } from '@/lib/catalog-message';
import { CatalogCards } from './catalog-cards';
import { ApprovalSummary, CalculationResults, MessageActions } from './advisor-blocks';

function Message({ message, actionsEnabled, onAction }: { message: ChatMessage; actionsEnabled: boolean; onAction: (body: string) => void }) {
  const [copyStatus, setCopyStatus] = useState('');
  const employee = message.sender_type === 'employee';
  const representative = message.sender_type === 'representative';
  const catalog = message.sender_type === 'assistant' ? decodeCatalogMessage(message.body) : null;
  const text = catalog?.text ?? message.body;
  const label = employee ? 'את' : representative ? 'נציגות השירות' : 'CarWise';
  return <article className={`cw-message cw-message-${message.sender_type}`} aria-label={`הודעה מאת ${label}`}>
    <div className="cw-message-avatar">{employee ? <ChatIcon name="user" /> : representative ? <ChatIcon name="chat" /> : <CarWiseMark small />}</div>
    <div className="cw-message-content"><div className="cw-message-byline"><strong>{label}</strong><time dateTime={message.created_at}>{new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.created_at))}</time>{representative && <span>מענה אנושי</span>}</div>
      <div className="cw-message-bubble" dir="auto">{text}</div>
      {catalog && <CatalogCards message={catalog} onSelect={actionsEnabled ? onAction : undefined} />}
      {catalog?.approval && <ApprovalSummary approval={catalog.approval} />}
      {catalog?.calculation && <CalculationResults calculation={catalog.calculation} />}
      {catalog?.actions && <MessageActions actions={catalog.actions} disabled={!actionsEnabled} onAction={onAction} />}
      <div className="cw-message-tools"><span><ChatIcon name="check" />נשמרה</span><button aria-label="העתקת תוכן ההודעה" onClick={async () => {
        try { await navigator.clipboard.writeText([text, ...(catalog?.cards.map(card => `${card.display_name} · ${card.group_code} · ${card.drive_type}`) ?? [])].join('\n')); setCopyStatus('הועתקה'); }
        catch { setCopyStatus('ההעתקה לא זמינה בדפדפן הזה'); }
      }}><ChatIcon name="copy" /><span>{copyStatus || 'העתקה'}</span></button></div>
      <span className="cw-sr-only" role="status">{copyStatus}</span>
    </div>
  </article>;
}

type Props = {
  messages: ChatMessage[]; loading: boolean; pending: OutgoingMessage | null;
  sending: boolean; hasOlder: boolean; olderLoading: boolean; error: string | null;
  onOlder: () => void; onRetry: () => void;
  thinking: boolean; aiError: string | null; aiNeedsLogin: boolean; onRetryAi: () => void;
  onAction: (body: string) => void; actionsDisabled: boolean;
};
export function ChatThread(props: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const metrics = useRef({ height: 0, top: 0, firstId: '', lastId: '', nearBottom: true });
  const [hasNew, setHasNew] = useState(false);
  const lastId = props.messages[props.messages.length - 1]?.id ?? '';
  const firstId = props.messages[0]?.id ?? '';
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const previous = metrics.current;
    if (previous.firstId && previous.firstId !== firstId && previous.lastId === lastId && previous.height && !props.pending) {
      element.scrollTop = previous.top + element.scrollHeight - previous.height;
    } else if (previous.nearBottom || props.pending || !previous.lastId) {
      element.scrollTop = element.scrollHeight; setHasNew(false);
    } else if (previous.lastId !== lastId) { setHasNew(true); }
    metrics.current = { height: element.scrollHeight, top: element.scrollTop, firstId, lastId,
      nearBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 100 };
  }, [props.messages, props.pending, props.loading, props.thinking, props.aiError, firstId, lastId]);

  const jumpToBottom = () => {
    const element = viewport.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    metrics.current.nearBottom = true; setHasNew(false);
  };

  return <section className="cw-thread-region" aria-label="השיחה הנוכחית">
    <div className="cw-thread-scroll" ref={viewport} onScroll={() => {
      const element = viewport.current;
      if (!element) return;
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      metrics.current = { ...metrics.current, top: element.scrollTop, height: element.scrollHeight, nearBottom };
      if (nearBottom) setHasNew(false);
    }}>
      <div className="cw-thread-inner">
        <div className="cw-thread-start"><ChatIcon name="shield" /><span>מרחב אישי. אפשר להמשיך בכל זמן.</span></div>
        {props.hasOlder && <button className="cw-load-older" onClick={props.onOlder} disabled={props.olderLoading}>{props.olderLoading ? 'טוענת הודעות…' : 'הודעות קודמות'}<ChatIcon name="clock" /></button>}
        {props.loading && <div className="cw-thread-skeleton" role="status" aria-label="טוענת את השיחה השמורה"><i /><i /><i /></div>}
        {props.error && <div className="cw-thread-error" role="alert"><p>{props.error}</p><button onClick={props.onRetry}><ChatIcon name="retry" />טעינה מחדש</button></div>}
        <div role="log" aria-label="הודעות בשיחה" aria-live="polite" aria-relevant="additions text" aria-busy={props.loading}>
          {props.messages.map(message => <Message key={message.id} message={message} onAction={props.onAction}
            actionsEnabled={!props.actionsDisabled && message.id === lastId && message.sender_type === 'assistant'} />)}
          {props.pending && <article className="cw-message cw-message-employee cw-message-unsaved"><div className="cw-message-avatar"><ChatIcon name="user" /></div><div className="cw-message-content"><div className="cw-message-byline"><strong>את</strong></div><div className="cw-message-bubble" dir="auto">{props.pending.body}</div><span className="cw-pending-status" role="status">{props.sending ? <><i className="cw-spinner" />שומרת את ההודעה…</> : <><ChatIcon name="clock" />השמירה עדיין לא אושרה · אפשר לנסות שוב למטה</>}</span></div></article>}
        </div>
        {props.thinking && <div className="cw-ai-thinking" role="status"><CarWiseMark small /><span>CarWise חושב איתך</span><i /><i /><i /></div>}
        {props.aiError && <div className="cw-ai-error" role="alert"><p>{props.aiError}</p>{props.aiNeedsLogin ? <a href="/login">להתחברות מחדש</a> : <button onClick={props.onRetryAi} disabled={props.thinking || Boolean(props.pending) || props.loading}><ChatIcon name="retry" />ניסיון חוזר למענה</button>}</div>}
        {!props.loading && props.messages.length > 0 && <div className="cw-ai-notice"><ChatIcon name="shield" /><div><p>חישובי הנטו נעשים במחשבון החברה לפי פרטים שאישרת. זו סימולציה ואינה תלוש שכר; התאמת עיסוק אינה אימות רשמי.</p></div></div>}
      </div>
    </div>
    {hasNew && <button className="cw-new-messages" onClick={jumpToBottom}><ChatIcon name="down" />להודעות החדשות</button>}
  </section>;
}
