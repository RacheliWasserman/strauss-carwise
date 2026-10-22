'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  chatApi, ChatApiError, ChatDelivery, confirmedOutgoing, conversationIdFrom, createdThreadSeed, mergeConversations,
  mergeMessages, parseOutgoing, type ChatConversation, type ChatCursor,
  type ChatMessage, type OutgoingMessage
} from '@/lib/chat-client';
import { chatTiming } from '@/lib/chat-timing';
import { useAssistantReply } from './use-assistant-reply';

function errorMessage(error: unknown) {
  return error instanceof ChatApiError ? error.message : 'משהו השתבש בחיבור. אפשר לנסות שוב.';
}

const activeKeyOf = (userId: string) => `carwise:active:${userId}`;
/** Which conversation the chat opens next (another page, e.g. the catalog sidebar, choosing one before navigating). */
export function rememberActiveConversation(userId: string, id: string | null) {
  try { localStorage.setItem(activeKeyOf(userId), id ?? 'new'); } catch { /* Storage is optional. */ }
}

export function useEmployeeChat(userId: string) {
  const activeKey = activeKeyOf(userId);
  const pendingKey = `carwise:pending:${userId}`;
  const [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [historyCursor, setHistoryCursor] = useState<ChatCursor | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [revealIds, setRevealIds] = useState<ReadonlySet<string>>(new Set());
  const visibleMessages = useRef(messages);
  visibleMessages.current = messages;
  const [messageCursor, setMessageCursor] = useState<ChatCursor | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<OutgoingMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [titles, setTitles] = useState<Record<string, string>>({});
  /** The conversation whose saved messages are loaded (null until the active one has loaded). */
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const delivery = useRef(new ChatDelivery());
  const sendLock = useRef(false);
  const historyLock = useRef(false);
  const olderLock = useRef(false);
  const pendingRef = useRef<OutgoingMessage | null>(null);
  const activeRef = useRef(activeId);
  const aiThinkingRef = useRef(false);
  /** A conversation just created by this client, with its saved first message: shown without reloading the thread. */
  const seededThread = useRef<{ id: string; messages: ChatMessage[] } | null>(null);
  activeRef.current = activeId;

  const receiveAssistant = useCallback((message: ChatMessage) => {
    if (activeRef.current !== message.conversation_id) return;
    if (!visibleMessages.current.some(item => item.id === message.id)) {
      setRevealIds(current => new Set(current).add(message.id));
      chatTiming.start('reply_render');
    }
    setMessages(current => mergeMessages(current, [message]));
    setConversations(current => mergeConversations(current, current.filter(item => item.id === message.conversation_id)
      .map(item => ({ ...item, last_message_at: message.created_at, updated_at: message.created_at }))));
  }, []);
  const assistant = useAssistantReply({ conversationId: activeId, messages,
    paused: !ready || threadLoading || sending || Boolean(pending) || Boolean(threadError), onMessage: receiveAssistant });
  aiThinkingRef.current = assistant.thinking;

  const remember = useCallback((id: string | null) => {
    try { localStorage.setItem(activeKey, id ?? 'new'); } catch { /* Storage is optional. */ }
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('conversation', id); else url.searchParams.delete('conversation');
    window.history.replaceState(null, '', url);
  }, [activeKey]);

  useEffect(() => {
    const urlId = conversationIdFrom(new URLSearchParams(window.location.search).get('conversation'));
    let savedId: string | null = null;
    let operation: OutgoingMessage | null = null;
    try {
      savedId = conversationIdFrom(localStorage.getItem(activeKey));
      operation = parseOutgoing(sessionStorage.getItem(pendingKey));
    } catch { /* Private browsing can disable browser storage. */ }
    pendingRef.current = operation;
    setPending(operation);
    setActiveId(operation ? operation.conversationId : urlId ?? savedId);
    if (operation) {
      setDraft(operation.body);
      setSendError('שליחה קודמת לא אושרה. אפשר ללחוץ על "ניסיון חוזר" כדי לוודא שההודעה נשמרה פעם אחת.');
    }
    setReady(true);
  }, [activeKey, pendingKey]);

  const loadHistory = useCallback(async (cursor: ChatCursor | null = null, signal?: AbortSignal) => {
    if (historyLock.current) return;
    historyLock.current = true;
    setHistoryLoading(true); setHistoryError(null);
    try {
      const page = await chatApi.list(cursor, signal);
      if (signal?.aborted) return;
      setConversations(current => mergeConversations(current, page.conversations));
      setHistoryCursor(page.nextCursor);
    } catch (error) {
      if (!signal?.aborted) { setHistoryError(errorMessage(error)); setNeedsLogin(error instanceof ChatApiError && error.status === 401); }
    } finally { historyLock.current = false; if (!signal?.aborted) setHistoryLoading(false); }
  }, []);

  useEffect(() => {
    if (!ready) return;
    // The lock handles duplicate Strict Mode effects without cancelling the shared read.
    void loadHistory();
  }, [ready, loadHistory]);

  const reconcilePending = useCallback((saved: ChatMessage[]) => {
    const operation = pendingRef.current;
    if (sendLock.current || !operation || !confirmedOutgoing(operation, saved, userId)) return;
    pendingRef.current = null; delivery.current = new ChatDelivery();
    setPending(null); setDraft(''); setSendError(null);
    try { sessionStorage.removeItem(pendingKey); } catch { /* Optional browser recovery. */ }
  }, [userId, pendingKey]);

  const loadThread = useCallback(async (id: string, signal?: AbortSignal) => {
    setThreadLoading(true); setThreadError(null);
    try {
      const [details, page] = await Promise.all([chatApi.conversation(id, signal), chatApi.messages(id, null, signal)]);
      if (signal?.aborted || activeRef.current !== id) return;
      setConversations(current => mergeConversations(current, [details.conversation]));
      setMessages(page.messages); setMessageCursor(page.nextCursor); setLoadedId(id);
      reconcilePending(page.messages);
      if (!page.nextCursor && page.messages[0]) setTitles(current => ({ ...current, [id]: page.messages[0].body.slice(0, 70) }));
    } catch (error) {
      if (!signal?.aborted && activeRef.current === id) {
        setThreadError(errorMessage(error)); setNeedsLogin(error instanceof ChatApiError && error.status === 401);
      }
    } finally { if (!signal?.aborted && activeRef.current === id) setThreadLoading(false); }
  }, [reconcilePending]);

  useEffect(() => {
    const seed = seededThread.current?.id === activeId ? seededThread.current : null;
    seededThread.current = null;
    setMessages(seed?.messages ?? []); setRevealIds(new Set()); setMessageCursor(null); setThreadError(null);
    // A conversation this client just created holds only the message it saved: the reply starts without a reload.
    if (seed && ready) { setLoadedId(seed.id); setThreadLoading(false); return; }
    setThreadLoading(Boolean(activeId));
    if (!ready || !activeId) return;
    const controller = new AbortController();
    void loadThread(activeId, controller.signal);
    return () => controller.abort();
  }, [activeId, ready, loadThread]);

  // Fetch newly saved representative/assistant messages while a conversation is visible.
  useEffect(() => {
    if (!activeId || threadLoading || threadError) return;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading || document.hidden || sendLock.current) return;
      reading = true;
      try {
        const page = await chatApi.messages(activeId, null, controller.signal);
        if (!controller.signal.aborted) {
          setMessages(current => mergeMessages(current, page.messages));
          reconcilePending(page.messages);
        }
      } catch { /* Keep saved content visible; foreground reload has explicit error handling. */ }
      finally { reading = false; }
    };
    const timer = window.setInterval(() => void refresh(), 15000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [activeId, threadLoading, threadError, reconcilePending]);

  const selectConversation = useCallback((id: string | null) => {
    if (sendLock.current || pendingRef.current || aiThinkingRef.current) return;
    remember(id); setActiveId(id); setDraft(''); setSendError(null);
  }, [remember]);

  const loadOlder = async () => {
    if (!activeId || !messageCursor || olderLock.current) return;
    const id = activeId;
    olderLock.current = true; setOlderLoading(true); setThreadError(null);
    try {
      const page = await chatApi.messages(id, messageCursor);
      if (activeRef.current !== id) return;
      setMessages(current => mergeMessages(page.messages, current)); setMessageCursor(page.nextCursor);
      if (!page.nextCursor && page.messages[0]) setTitles(current => ({ ...current, [id]: page.messages[0].body.slice(0, 70) }));
    } catch (error) { if (activeRef.current === id) setThreadError(errorMessage(error)); }
    finally { olderLock.current = false; setOlderLoading(false); }
  };

  const execute = async (operation: OutgoingMessage, keepDraft = false) => {
    if (sendLock.current) return;
    sendLock.current = true; pendingRef.current = operation;
    setSending(true); setPending(operation); setSendError(null);
    // Temporary recovery only, scoped to this authenticated user. Removed on confirmation.
    try { sessionStorage.setItem(pendingKey, JSON.stringify(operation)); } catch { /* In-memory retry still works. */ }
    chatTiming.start('message_saved', 'reply_on_screen');
    try {
      const result = await delivery.current.deliver(operation);
      chatTiming.end('message_saved');
      remember(result.conversationId);
      setTitles(current => current[result.conversationId] ? current : { ...current, [result.conversationId]: operation.body.slice(0, 70) });
      const seed = createdThreadSeed(operation, result, userId);
      if (seed) seededThread.current = { id: result.conversationId, messages: seed };
      if (result.message) {
        const message = result.message;
        setMessages(current => mergeMessages(current, [message]));
        setConversations(current => mergeConversations(current, current.filter(item => item.id === result.conversationId)
          .map(item => ({ ...item, last_message_at: message.created_at, updated_at: message.created_at }))));
      }
      setActiveId(result.conversationId); if (!keepDraft) setDraft(''); setPending(null); pendingRef.current = null;
      setNeedsLogin(false);
      try { sessionStorage.removeItem(pendingKey); } catch { /* Saving to Supabase already succeeded. */ }
      void loadHistory();
    } catch (error) {
      chatTiming.cancel('message_saved', 'reply_on_screen');
      setSendError(errorMessage(error)); setNeedsLogin(error instanceof ChatApiError && error.status === 401);
    } finally { sendLock.current = false; setSending(false); }
  };

  const submit = () => {
    if (sendLock.current || !ready || aiThinkingRef.current) return;
    if (pendingRef.current) { void execute(pendingRef.current); return; }
    if (threadLoading || (threadError && !messages.length)) return;
    const body = draft.trim();
    if (!body || body.length > 16000) return;
    void execute({ requestId: crypto.randomUUID(), conversationId: activeId, body });
  };

  // Quick replies are ordinary employee messages; approvals are validated by the server against their code.
  const sendText = (body: string) => {
    if (sendLock.current || !ready || aiThinkingRef.current || pendingRef.current || !activeId) return;
    const text = body.trim();
    if (!text || text.length > 16000) return;
    void execute({ requestId: crypto.randomUUID(), conversationId: activeId, body: text }, true);
  };
  /**
   * An ordinary employee message sent on the employee's own action elsewhere (e.g. a catalog vehicle's button): into
   * the active conversation once its saved messages are loaded, or as the first message of a new conversation.
   * Returns whether it was sent; the server handles it exactly like typed text.
   */
  const sendWhenReady = (body: string) => {
    const text = body.trim();
    if (sendLock.current || !ready || aiThinkingRef.current || pendingRef.current || !text || text.length > 16000) return false;
    if (activeId && (loadedId !== activeId || threadLoading || threadError)) return false;
    void execute({ requestId: crypto.randomUUID(), conversationId: activeId, body: text }, true);
    return true;
  };

  return {
    ready, activeId, sendText, sendWhenReady, conversations, historyCursor, historyLoading, historyError,
    messages, revealIds, messageCursor, threadLoading, olderLoading, threadError,
    draft, setDraft, pending, sending, sendError, needsLogin, titles,
    selectConversation, submit, loadOlder,
    loadMoreHistory: () => loadHistory(historyCursor),
    retryHistory: () => loadHistory(),
    retryThread: () => activeId && loadThread(activeId),
    assistant
  };
}
