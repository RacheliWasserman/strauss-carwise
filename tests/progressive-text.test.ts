import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProgressiveText, revealCount, textGraphemes, TYPING_MS_PER_CHARACTER } from '../src/components/chat/progressive-text';

describe('assistant text reveal', () => {
  it('reveals short Hebrew progressively and completes without a long wait', () => {
    expect(revealCount(20, 0)).toBe(0);
    expect(TYPING_MS_PER_CHARACTER).toBe(35);
    expect(revealCount(20, 34)).toBe(0);
    expect(revealCount(20, 35)).toBe(1);
    expect(revealCount(20, 350)).toBe(10);
    expect(revealCount(20, 700)).toBe(20);
  });
  it('accelerates long answers in chunks and bounds duration', () => {
    expect(revealCount(600, 7000)).toBe(300);
    expect(revealCount(600, 14000)).toBe(600);
    expect(revealCount(12000, 15000)).toBe(12000);
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
});
