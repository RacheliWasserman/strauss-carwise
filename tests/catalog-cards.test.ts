import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogCards } from '../src/components/chat/catalog-cards';
import { decodeCatalogMessage, encodeCatalogMessage, type CatalogMessage } from '../src/lib/catalog-message';

afterEach(() => vi.unstubAllGlobals());
const snapshot: CatalogMessage = {
  kind:'carwise.catalog.v1', text:'אפשרויות מהקטלוג', recordedAt:'2026-10-19T10:00:00.000Z',
  state:{group:'ב',groupSource:'employee_reported',awaitingGroup:false,filters:{}},
  cards:[{id:'FIXTURE-ID',display_name:'<script>unsafe()</script>',manufacturer_name:'Fixture maker',group_code:'א',drive_type:'חשמלי'}]
};
it('renders persisted card snapshots after reload as escaped content with provenance and no invented financial fields', () => {
  // Vitest uses classic JSX transformation; Next.js uses the automatic runtime.
  vi.stubGlobal('React',React);
  const restored = decodeCatalogMessage(JSON.parse(JSON.stringify({body:encodeCatalogMessage(snapshot)})).body)!;
  const html = renderToStaticMarkup(React.createElement(CatalogCards,{message:restored}));
  expect(html).toContain('FIXTURE-ID'); expect(html).toContain('Fixture maker'); expect(html).toContain('חשמלי');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  expect(html).toContain('אינו אישור זכאות'); expect(html).toContain('הזמינות עשויה להשתנות');
  expect(html).not.toMatch(/מחיר|שכר|₪/);
});
it('does not render an empty recommendation grid', () => {
  vi.stubGlobal('React',React);
  expect(renderToStaticMarkup(React.createElement(CatalogCards,{message:{...snapshot,cards:[]}}))).toBe('');
});
