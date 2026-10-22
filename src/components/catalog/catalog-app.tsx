'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { chatApi, ChatApiError, mergeConversations, type ChatConversation, type ChatCursor } from '@/lib/chat-client';
import type { Showroom } from '@/lib/catalog/showroom-service';
import { ChatSidebar } from '../chat/chat-sidebar';
import { ChatIcon } from '../chat/chat-icon';
import { rememberActiveConversation } from '../chat/use-employee-chat';
import type { EmployeeAccount } from '../chat/employee-chat';
import { CatalogBrowser } from './catalog-browser';
import '../chat/employee-chat.css';
import './catalog.css';

/** The employee's conversation list for the sidebar (read only here; choosing one opens it in the chat). */
function useConversationList() {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [cursor, setCursor] = useState<ChatCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (from: ChatCursor | null = null) => {
    setLoading(true); setError(null);
    try {
      const page = await chatApi.list(from);
      setConversations(current => mergeConversations(current, page.conversations)); setCursor(page.nextCursor);
    } catch (problem) { setError(problem instanceof ChatApiError ? problem.message : 'לא הצלחתי לטעון את השיחות.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { conversations, cursor, loading, error, load };
}

export function CatalogApp({ userId, account, showroom, aliases }: {
  userId: string; account?: EmployeeAccount; showroom: Showroom; aliases: Record<string, string[]>;
}) {
  const router = useRouter();
  const list = useConversationList();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const openConversation = (id: string | null) => {
    rememberActiveConversation(userId, id);
    router.push(id ? `/employee?${new URLSearchParams({ conversation: id })}` : '/employee');
  };

  return <main className="cw-app cw-catalog-app" dir="rtl">
    <a href="#cw-catalog-main" className="cw-skip-link">מעבר לקטלוג</a>
    <ChatSidebar conversations={list.conversations} titles={{}} activeId={null} section="catalog" account={account}
      open={sidebarOpen} onClose={closeSidebar} locked={false} loading={list.loading} error={list.error} hasMore={Boolean(list.cursor)}
      onLoadMore={() => void list.load(list.cursor)} onRetry={() => void list.load()} onSelect={id => { closeSidebar(); openConversation(id); }} />
    <div className="cw-workspace" inert={sidebarOpen || undefined}>
      <header className="cw-topbar">
        <div className="cw-topbar-title">
          <button className="cw-icon-button cw-menu-toggle" aria-label="פתיחת התפריט" aria-expanded={sidebarOpen} aria-controls="cw-sidebar" onClick={() => setSidebarOpen(true)}><ChatIcon name="menu" /></button>
          <span className="cw-topbar-symbol"><ChatIcon name="car" /></span>
          <div><strong>קטלוג רכבי החברה</strong><span>{account ? `${account.firstName}, כל הרכבים במקום אחד` : 'כל הרכבים במקום אחד'}</span></div>
        </div>
        <Link href="/employee" className="cw-showroom-back"><ChatIcon name="chat" /><span>חזרה לשיחה</span></Link>
      </header>
      <div id="cw-catalog-main" className="cw-showroom-scroll" tabIndex={-1}>
        <CatalogBrowser showroom={showroom} aliases={aliases} onRetry={() => router.refresh()} />
      </div>
    </div>
  </main>;
}
