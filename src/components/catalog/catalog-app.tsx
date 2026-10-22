'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { Showroom } from '@/lib/catalog/showroom-service';
import { ChatSidebar } from '../chat/chat-sidebar';
import { ChatIcon } from '../chat/chat-icon';
import { rememberActiveConversation } from '../chat/use-employee-chat';
import { useConversationList } from '../chat/use-conversation-list';
import type { EmployeeAccount } from '../chat/employee-chat';
import { CatalogBrowser } from './catalog-browser';
import '../chat/employee-chat.css';
import './catalog.css';

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
        <Link href="/employee" className="cw-showroom-back" aria-label="חזרה לדף הבית"><ChatIcon name="back" /><span>חזרה לדף הבית</span></Link>
      </header>
      <div id="cw-catalog-main" className="cw-showroom-scroll" tabIndex={-1}>
        <CatalogBrowser showroom={showroom} aliases={aliases} onRetry={() => router.refresh()} />
      </div>
    </div>
  </main>;
}
