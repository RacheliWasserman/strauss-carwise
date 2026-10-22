'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export const TYPING_MS_PER_CHARACTER = 35;
const LONG_RESPONSE_THRESHOLD = 400;
const MAX_TYPING_SPEED_MULTIPLIER = 1.5;
const MAX_REVEAL_DURATION_MS = 15000;

/** Consistent rhythm per reply, gently faster for long text; graphemes stay intact. */
export function revealCount(length: number, elapsed: number) {
  if (length <= 0) return 0;
  const speedMultiplier = Math.min(MAX_TYPING_SPEED_MULTIPLIER, Math.max(1, length / LONG_RESPONSE_THRESHOLD));
  const duration = Math.min(MAX_REVEAL_DURATION_MS, length * TYPING_MS_PER_CHARACTER / speedMultiplier);
  return Math.min(length, Math.floor(length * Math.max(0, elapsed) / duration));
}
export function textGraphemes(text: string) {
  return Array.from(new Intl.Segmenter('he', { granularity: 'grapheme' }).segment(text), part => part.segment);
}

/** Presentation only: the complete, accessible text and its layout exist immediately. */
export function ProgressiveText({ text, animate }: { text: string; animate: boolean }) {
  const parts = useMemo(() => textGraphemes(text), [text]);
  const [visible, setVisible] = useState(parts.length);
  const finishRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (!animate || !text) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) return;
    let frame = 0;
    let stopped = false;
    const start = performance.now();
    setVisible(0);
    const tick = (now: number) => {
      if (stopped) return;
      const count = revealCount(parts.length, now - start);
      setVisible(count);
      if (count < parts.length) frame = requestAnimationFrame(tick);
    };
    const finish = () => { stopped = true; cancelAnimationFrame(frame); setVisible(parts.length); };
    finishRef.current = finish;
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
    <span className="cw-reveal-visible" aria-hidden="true">{parts.slice(0, visible).join('')}<span className="cw-reveal-cursor" /></span>
    <button type="button" className="cw-reveal-all" onClick={() => finishRef.current()}>הצג הכול</button>
  </span>;
}
