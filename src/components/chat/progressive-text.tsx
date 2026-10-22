'use client';

import { useLayoutEffect, useMemo, useState } from 'react';
import { chatTiming } from '../../lib/chat-timing';

/** A newly received reply is fully visible: ends the frontend timing phases (no-ops when none were started). */
function revealed() { chatTiming.end('reply_render'); chatTiming.end('reply_on_screen'); }

/**
 * The reply is complete when it arrives, so the reveal is only a short, subtle transition: it never makes the
 * employee wait for text that is already there. Short replies finish sooner; every reply finishes within the cap.
 */
export const REVEAL_MS_PER_CHARACTER = 3;
export const MAX_REVEAL_DURATION_MS = 320;

export function revealCount(length: number, elapsed: number) {
  if (length <= 0) return 0;
  const duration = Math.min(MAX_REVEAL_DURATION_MS, length * REVEAL_MS_PER_CHARACTER);
  return Math.min(length, Math.floor(length * Math.max(0, elapsed) / duration));
}
export function textGraphemes(text: string) {
  return Array.from(new Intl.Segmenter('he', { granularity: 'grapheme' }).segment(text), part => part.segment);
}

/** Presentation only: the complete, accessible text and its layout exist immediately. */
export function ProgressiveText({ text, animate }: { text: string; animate: boolean }) {
  const parts = useMemo(() => textGraphemes(text), [text]);
  const [visible, setVisible] = useState(parts.length);
  useLayoutEffect(() => {
    if (!animate || !text) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) { const frame = requestAnimationFrame(revealed); return () => cancelAnimationFrame(frame); }
    let frame = 0;
    let stopped = false;
    const start = performance.now();
    setVisible(0);
    const tick = (now: number) => {
      if (stopped) return;
      const count = revealCount(parts.length, now - start);
      setVisible(count);
      if (count < parts.length) frame = requestAnimationFrame(tick);
      else revealed();
    };
    const finish = () => { stopped = true; cancelAnimationFrame(frame); setVisible(parts.length); revealed(); };
    preference.addEventListener('change', finish);
    frame = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(frame); preference.removeEventListener('change', finish); };
    // A mounted message is revealed once; parent rerenders never restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  if (visible >= parts.length) return <span className="cw-reveal" dir="auto">{text}</span>;
  return <span className="cw-reveal" dir="auto">
    <span className="cw-reveal-reserve" aria-hidden="true">{text}</span>
    <span className="cw-sr-only">{text}</span>
    <span className="cw-reveal-visible" aria-hidden="true">{parts.slice(0, visible).join('')}</span>
  </span>;
}
