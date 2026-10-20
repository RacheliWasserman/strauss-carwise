'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { chatApi, ChatApiError, type ChatMessage } from '@/lib/chat-client';

type Options = { conversationId: string | null; messages: ChatMessage[]; paused: boolean; onMessage: (message: ChatMessage) => void };
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, 2000);
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
function friendly(error: unknown) {
  if (error instanceof ChatApiError) {
    if (error.status === 401) return 'ההודעה שלך נשמרה. כדי לקבל מענה, התחברי שוב לחשבון.';
    if (error.code === 'AI_SAVE_UNCERTAIN') return 'אנחנו בודקים אם התשובה כבר נשמרה. ניסיון חוזר יבדוק את השמירה בלי ליצור תשובה כפולה.';
    if (error.status === 429) return 'ההודעה שלך נשמרה. כדאי להמתין מעט לפני בקשת מענה נוסף.';
  }
  return 'ההודעה שלך נשמרה. היועץ לא זמין כרגע — אפשר לנסות שוב, בלי לשלוח את ההודעה מחדש.';
}

export function useAssistantReply({ conversationId, messages, paused, onMessage }: Options) {
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [retryId, setRetryId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const attempted = useRef(new Set<string>());
  const failures = useRef(new Map<string, string>());

  useEffect(() => {
    setThinking(false); setError(null); setRetryId(null); setNeedsLogin(false);
    return () => { controller.current?.abort(); busy.current = false; };
  }, [conversationId]);

  const run = useCallback(async (messageId: string) => {
    if (!conversationId || busy.current) return;
    const key = `${conversationId}:${messageId}`;
    busy.current = true; attempted.current.add(key);
    const current = new AbortController(); controller.current = current;
    setThinking(true); setError(null); setRetryId(messageId);
    try {
      let result = await chatApi.assistant(conversationId, messageId, false, current.signal);
      for (let poll = 0; result.status === 'pending' && poll < 15; poll++) {
        await wait(current.signal);
        result = await chatApi.assistant(conversationId, messageId, true, current.signal);
      }
      if (result.status !== 'complete' || result.message.sender_type !== 'assistant' || result.message.conversation_id !== conversationId) throw new ChatApiError(503);
      if (!current.signal.aborted) { onMessage(result.message); failures.current.delete(key); setRetryId(null); setNeedsLogin(false); }
    } catch (failure) {
      if (!current.signal.aborted) {
        const text = friendly(failure); failures.current.set(key, text); setError(text);
        setNeedsLogin(failure instanceof ChatApiError && failure.status === 401);
      }
    } finally {
      if (controller.current === current) { busy.current = false; if (!current.signal.aborted) setThinking(false); }
    }
  }, [conversationId, onMessage]);

  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (latest?.sender_type === 'assistant' && !thinking && error) { setError(null); setRetryId(null); return; }
    if (!conversationId || paused || thinking || latest?.sender_type !== 'employee' || latest.conversation_id !== conversationId) return;
    const key = `${conversationId}:${latest.id}`;
    const previousFailure = failures.current.get(key);
    if (previousFailure) { setError(previousFailure); setRetryId(latest.id); return; }
    if (!attempted.current.has(key)) void run(latest.id);
  }, [conversationId, messages, paused, thinking, error, run]);

  return { thinking, error, needsLogin, retry: () => { if (retryId && !paused) void run(retryId); } };
}
