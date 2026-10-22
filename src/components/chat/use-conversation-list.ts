'use client';

import { useCallback, useEffect, useState } from 'react';
import { chatApi, ChatApiError, mergeConversations, type ChatConversation, type ChatCursor } from '@/lib/chat-client';

/**
 * The employee's conversation list for the sidebar on pages other than the chat (catalog, Match, profile): read only
 * there; choosing a conversation opens it in the chat. Kept in its own module so those pages do not bundle each other.
 */
export function useConversationList() {
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
