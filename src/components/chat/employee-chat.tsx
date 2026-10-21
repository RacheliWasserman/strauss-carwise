'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatSidebar } from './chat-sidebar';
import { ChatWelcome } from './chat-welcome';
import { ChatThread } from './chat-thread';
import { ChatComposer } from './chat-composer';
import { ChatIcon } from './chat-icon';
import { useEmployeeChat } from './use-employee-chat';
import { PayslipUpload } from './payslip-upload';
import { greeting } from '../../lib/identity/greeting';
import './employee-chat.css';

export type EmployeeAccount = { firstName: string; fullName: string };

export function EmployeeChat({ userId, account }: { userId: string; account?: EmployeeAccount }) {
  const firstName = account?.firstName;
  const chat = useEmployeeChat(userId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [payslipOpen, setPayslipOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const app = useRef<HTMLElement>(null);
  const wasSending = useRef(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const showThread = Boolean(chat.activeId || chat.pending);
  const locked = Boolean(chat.pending);
  const activeConversation = chat.conversations.find(conversation => conversation.id === chat.activeId);

  useEffect(() => {
    const viewport = window.visualViewport;
    const syncHeight = () => { app.current?.style.setProperty('--cw-height', `${viewport?.height ?? window.innerHeight}px`); };
    syncHeight(); viewport?.addEventListener('resize', syncHeight);
    const desktop = window.matchMedia('(min-width: 801px)');
    const closeOnDesktop = () => { if (desktop.matches) setSidebarOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => { viewport?.removeEventListener('resize', syncHeight); desktop.removeEventListener('change', closeOnDesktop); };
  }, []);

  useEffect(() => {
    if (wasSending.current && !chat.sending && !chat.pending) input.current?.focus({ preventScroll: true });
    wasSending.current = chat.sending;
  }, [chat.sending, chat.pending]);

  return <main ref={app} className="cw-app" dir="rtl">
    <a href="#cw-message" className="cw-skip-link">מעבר לכתיבת הודעה</a>
    <ChatSidebar conversations={chat.conversations} titles={chat.titles} activeId={chat.activeId}
      account={account} open={sidebarOpen} onClose={closeSidebar} locked={locked || chat.assistant.thinking} loading={chat.historyLoading}
      error={chat.historyError} hasMore={Boolean(chat.historyCursor)} onLoadMore={chat.loadMoreHistory} onRetry={chat.retryHistory}
      onSelect={id => { chat.selectConversation(id); closeSidebar(); }} />
    <div className="cw-workspace" inert={sidebarOpen || undefined}>
      <header className="cw-topbar">
        <div className="cw-topbar-title"><button className="cw-icon-button cw-menu-toggle" aria-label="פתיחת תפריט השיחות" aria-expanded={sidebarOpen} aria-controls="cw-sidebar" onClick={() => setSidebarOpen(true)}><ChatIcon name="menu" /></button><span className="cw-topbar-symbol"><ChatIcon name="route" /></span><div><strong>{chat.activeId ? activeConversation?.title || chat.titles[chat.activeId] || 'השיחה שלך' : 'הדרך לרכב הבא שלך'}</strong><span>{firstName ? greeting(firstName) : 'המרחב האישי שלך ב־CarWise'}</span></div></div>
        <span className="cw-stage-badge"><i />יועץ הרכב שלך</span>
      </header>
      <div className="cw-chat-body">
        {!chat.ready ? <div className="cw-initial-loading" role="status"><i className="cw-spinner" /><span>המרחב האישי נפתח…</span></div>
          : showThread ? <ChatThread key={chat.activeId ?? 'new'} messages={chat.messages} pending={chat.pending} sending={chat.sending}
            thinking={chat.assistant.thinking} aiError={chat.assistant.error} aiNeedsLogin={chat.assistant.needsLogin} onRetryAi={chat.assistant.retry}
            loading={chat.threadLoading} error={chat.threadError} hasOlder={Boolean(chat.messageCursor)} olderLoading={chat.olderLoading}
            onOlder={() => void chat.loadOlder()} onRetry={() => void chat.retryThread()}
            onAction={chat.sendText} actionsDisabled={locked || chat.sending || chat.assistant.thinking || chat.threadLoading}
            onPayslip={() => setPayslipOpen(true)} />
          : <div className="cw-welcome-scroll"><ChatWelcome firstName={firstName} disabled={!chat.ready} onSuggest={body => { chat.setDraft(body); input.current?.focus(); }} /></div>}
        <ChatComposer value={chat.draft} onChange={chat.setDraft} onSubmit={chat.submit} sending={chat.sending} pending={locked}
          disabled={!chat.ready || chat.assistant.thinking || (!locked && (chat.threadLoading || Boolean(chat.threadError && !chat.messages.length)))}
          error={chat.sendError} needsLogin={chat.needsLogin} textareaRef={input}
          onPayslip={() => setPayslipOpen(true)} payslipDisabled={!chat.activeId || locked || chat.sending || chat.assistant.thinking || chat.threadLoading} />
        {payslipOpen && chat.activeId && <PayslipUpload conversationId={chat.activeId} busy={locked || chat.sending || chat.assistant.thinking}
          onSubmit={chat.sendText} onClose={() => setPayslipOpen(false)} />}
      </div>
      {locked && !chat.sending && <p className="cw-recovery-note" role="status">כדי למנוע כפילות, יש להשלים את הניסיון החוזר לפני מעבר לשיחה אחרת.</p>}
    </div>
  </main>;
}
