import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { RepresentativeDemoCard, REPRESENTATIVE_DEMO_LOGIN } from '../src/components/representative-demo-card';
afterEach(() => vi.unstubAllGlobals());
it('shows the owner-approved public demo details with a non-submit fill button', () => {
  vi.stubGlobal('React', React);
  const fill=vi.fn();
  const html=renderToStaticMarkup(React.createElement(RepresentativeDemoCard,{onFill:fill,disabled:false}));
  expect(html).toContain(REPRESENTATIVE_DEMO_LOGIN.email);
  expect(html).toContain(REPRESENTATIVE_DEMO_LOGIN.password);
  expect(html).toContain('כניסת נציג — סביבת הדגמה');
  expect(html).toMatch(/<button type="button"/);
  expect(fill).not.toHaveBeenCalled();
});
it('disables the fill action while a login is being submitted',()=>{
  vi.stubGlobal('React',React);
  expect(renderToStaticMarkup(React.createElement(RepresentativeDemoCard,{onFill:()=>{},disabled:true}))).toMatch(/<button type="button" disabled/);
});
