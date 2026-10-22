import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MAX_REVEAL_DURATION_MS, ProgressiveText, REVEAL_MS_PER_CHARACTER, revealCount, textGraphemes } from '../src/components/chat/progressive-text';

describe('assistant text reveal', () => {
  it('reveals a short Hebrew reply as a brief transition, never character-by-character typing', () => {
    expect(REVEAL_MS_PER_CHARACTER).toBeLessThanOrEqual(5);
    expect(revealCount(20, 0)).toBe(0);
    expect(revealCount(20, 30)).toBe(10);
    expect(revealCount(20, 60)).toBe(20);
  });
  it('shows long and very long replies in full within the same short cap', () => {
    expect(MAX_REVEAL_DURATION_MS).toBeLessThanOrEqual(400);
    expect(revealCount(600, MAX_REVEAL_DURATION_MS / 2)).toBe(300);
    expect(revealCount(600, MAX_REVEAL_DURATION_MS)).toBe(600);
    expect(revealCount(12000, MAX_REVEAL_DURATION_MS)).toBe(12000);
    expect(revealCount(12000, 60000)).toBe(12000);
    expect(revealCount(0, 0)).toBe(0);
    expect(revealCount(10, -1)).toBe(0);
  });
  it('keeps Hebrew vowel marks and combined emoji intact', () => {
    const text = 'שָׁלוֹם 👩‍💻';
    expect(textGraphemes(text).join('')).toBe(text);
    expect(textGraphemes(text)).toContain('שָׁ');
    expect(textGraphemes(text)).toContain('👩‍💻');
  });
  it('keeps exact formatted/financial text and safe escaping in static history', () => {
    vi.stubGlobal('React', React);
    const text = '**השוואה**\n- נטו: 12,345 ₪\n[קישור](https://example.com)\n<script>';
    const html = renderToStaticMarkup(React.createElement(ProgressiveText, { text, animate: false }));
    expect(html).toContain('**השוואה**');
    expect(html).toContain('12,345 ₪');
    expect(html).toContain('[קישור](https://example.com)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('cw-reveal-cursor');
    expect(html).not.toContain('<button');
    vi.unstubAllGlobals();
  });
  it('keeps mixed Hebrew, English and numbers in one bidi-isolated block in reading order', () => {
    vi.stubGlobal('React', React);
    const text = 'בחרת ב־ATTO 3 (CAR-10). ההשפעה על הנטו: ‎-1,234 ₪ לחודש.';
    const html = renderToStaticMarkup(React.createElement(ProgressiveText, { text, animate: true }));
    // Server markup (and the first paint before any effect) is the complete text: nothing is hidden or reordered.
    expect(html).toBe(`<span class="cw-reveal" dir="auto">${text}</span>`);
    expect(textGraphemes(text).join('')).toBe(text);
    vi.unstubAllGlobals();
  });
});
