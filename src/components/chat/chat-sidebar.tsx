'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { ChatConversation } from '@/lib/chat-client';
import { LogoutButton } from '@/components/logout-button';
import { ChatIcon } from './chat-icon';
import { BrandLockup } from '../brand/brand-lockup';
import { CarWiseCarLoader } from '../ui/carwise-car-loader';

type Props = {
  conversations: ChatConversation[]; titles: Record<string, string>; activeId: string | null;
  open: boolean; locked: boolean; loading: boolean; error: string | null; hasMore: boolean;
  onClose: () => void; onSelect: (id: string | null) => void;
  onLoadMore: () => void; onRetry: () => void;
  /** The signed-in account's stored name, when the identity record exists. */
  account?: { firstName: string; fullName: string };
  /** The page the sidebar is shown on; its link is marked as the current page there. */
  section?: 'chat' | 'catalog' | 'match' | 'profile';
};
/** Up to two initials from the stored name, for the account avatar. */
export const initials = (fullName: string) => fullName.split(/[\s-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('');
function groupLabel(value: string) {
  const date = new Date(value), today = new Date();
  if (date.toDateString() === today.toDateString()) return 'היום';
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'אתמול';
  return 'שיחות קודמות';
}

export function ChatSidebar(props: Props) {
  const panel = useRef<HTMLElement>(null);
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? [])]
      .filter(element => element.getClientRects().length);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const items = focusable(), first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previousFocus?.focus(); };
  }, [open, onClose]);

  return <>
    {open && <button className="cw-drawer-shade" aria-label="סגירת תפריט השיחות" tabIndex={-1} onClick={onClose} />}
    <aside ref={panel} id="cw-sidebar" className={`cw-sidebar ${open ? 'cw-sidebar-open' : ''}`}
      aria-label="היסטוריית שיחות" role={open ? 'dialog' : undefined} aria-modal={open || undefined}>
      <div className="cw-sidebar-brand">
        <BrandLockup tone="light" />
        <button className="cw-icon-button cw-drawer-close" aria-label="סגירת תפריט השיחות" onClick={onClose}><ChatIcon name="close" /></button>
      </div>
      {/* The one way into "הפרופיל שלי", right above "שיחה חדשה". While a message is still being confirmed or answered,
          leaving the chat is held back (as switching conversations is), so nothing in progress is lost. */}
      <Link href="/profile" className={`cw-profile-nav ${props.section === 'profile' ? 'cw-profile-nav-active' : ''}`}
        aria-current={props.section === 'profile' ? 'page' : undefined} aria-disabled={props.locked || undefined}
        onClick={event => { if (props.locked) { event.preventDefault(); return; } onClose(); }}>
        <span className="cw-profile-nav-icon" aria-hidden="true"><ChatIcon name="user" /></span>
        <span className="cw-profile-nav-text"><strong>הפרופיל שלי</strong><span>שכר, תפקיד ורכב נוכחי</span></span>
      </Link>
      <button className="cw-new-chat" disabled={props.locked} onClick={() => props.onSelect(null)}><ChatIcon name="plus" /><span>שיחה חדשה</span><span className="cw-new-chat-corner">↗</span></button>
      <div className="cw-history-heading"><span>השיחות שלך</span><ChatIcon name="clock" /></div>
      <nav className="cw-history" aria-label="בחירת שיחה" aria-busy={props.loading}>
        {props.loading && props.conversations.length === 0 && <div className="cw-history-skeleton" role="status" aria-label="השיחות בטעינה"><i /><i /><i /></div>}
        {!props.loading && !props.error && props.conversations.length === 0 && <div className="cw-history-empty"><ChatIcon name="chat" /><p>השיחה הראשונה שלך<br />מתחילה כאן.</p><span>כל השיחות יישמרו במקום אחד</span></div>}
        {props.conversations.map((conversation, index) => {
          const group = groupLabel(conversation.last_message_at);
          const showGroup = index === 0 || groupLabel(props.conversations[index - 1].last_message_at) !== group;
          return <div key={conversation.id}>
            {showGroup && <p className="cw-history-group">{group}</p>}
            <button className={`cw-history-item ${conversation.id === props.activeId ? 'cw-history-active' : ''}`}
              aria-current={conversation.id === props.activeId ? 'page' : undefined} disabled={props.locked}
              onClick={() => props.onSelect(conversation.id)}>
              <ChatIcon name="chat" /><span><strong>{conversation.title || props.titles[conversation.id] || 'השיחה שלי על הרכב'}</strong>
                <small>{new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(conversation.last_message_at))}</small></span>
              {conversation.id === props.activeId && <i className="cw-active-dot" />}
            </button>
          </div>;
        })}
        {props.error && <div className="cw-sidebar-error" role="alert"><p>{props.error}</p><button onClick={props.onRetry} disabled={props.loading}>ניסיון חוזר</button></div>}
        {props.hasMore && <button className="cw-history-more" onClick={props.onLoadMore} disabled={props.loading}>{props.loading ? <CarWiseCarLoader variant="button" label="בטעינה…" className="cw-on-dark" /> : 'שיחות נוספות'}<ChatIcon name="down" /></button>}
      </nav>
      <Link href="/catalog" className={`cw-catalog-nav ${props.section === 'catalog' ? 'cw-catalog-nav-active' : ''}`}
        aria-current={props.section === 'catalog' ? 'page' : undefined} onClick={onClose}>
        <span className="cw-catalog-nav-icon" aria-hidden="true"><ChatIcon name="car" /></span>
        <span className="cw-catalog-nav-text"><strong>קטלוג רכבי החברה</strong><span>גלו את הרכב הבא שלכם</span></span>
        <span className="cw-catalog-nav-arrow" aria-hidden="true"><ChatIcon name="forward" /></span>
      </Link>
      <Link href="/match" className={`cw-match-nav ${props.section === 'match' ? 'cw-match-nav-active' : ''}`}
        aria-current={props.section === 'match' ? 'page' : undefined} onClick={onClose}>
        <ChatIcon name="spark" /><span><strong>CarWise Match</strong> · התאמה אישית של רכב</span>
      </Link>
      <div className="cw-account"><span className="cw-account-avatar" aria-hidden="true">{props.account ? initials(props.account.fullName) : <ChatIcon name="user" />}</span><div><strong>{props.account?.fullName ?? 'האזור האישי שלך'}</strong><span>{props.account ? 'האזור האישי · STRAUSS' : 'STRAUSS · EMPLOYEE'}</span></div><LogoutButton /></div>
    </aside>
  </>;
}
