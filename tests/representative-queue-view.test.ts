import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/logout-button', () => ({ LogoutButton: () => null }));
import { durationLabel, isOverdue, matchesQuery, waitingText, type QueueItem } from '../src/lib/representative-queue-view';
import { loadRepresentativeData, NationalIdReveal, RequestHeader, requestSchema } from '../src/components/representative/representative-console';
import { ChatSidebar, initials } from '../src/components/chat/chat-sidebar';

afterEach(() => vi.unstubAllGlobals());
const NOW = Date.parse('2026-10-21T13:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const item = (extra: Partial<QueueItem> = {}): QueueItem => ({ status: 'open', requested_at: minutesAgo(12), answered_at: null,
  topic: 'שדה חסר: שכר בסיס חודשי ברוטו [base_salary]', assigned_representative_id: null, employee_name: 'רחלי כהן', occupation: 'מנהל/ת אזור מכירות', ...extra });

describe('representative refresh: coherent queue and answer snapshots',()=>{
  it('does not silently accept an answer endpoint failure',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({requests:[]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:'לא ניתן לטעון תשובות'}),{status:500}));
    await expect(loadRepresentativeData(new AbortController().signal,fetcher)).rejects.toThrow('לא ניתן לטעון תשובות');
  });
  it('loads empty snapshots and passes cancellation and same-origin credentials to both requests',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({requests:[]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({answers:[]})));
    const signal=new AbortController().signal;
    expect(await loadRepresentativeData(signal,fetcher)).toEqual({requests:[],answers:new Map()});
    for(const [,options] of fetcher.mock.calls) expect(options).toMatchObject({signal,credentials:'same-origin',cache:'no-store'});
  });
  it('rejects malformed responses without exposing payload values in the validation error',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({requests:[{id:'private-value'}]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({answers:[]})));
    await expect(loadRepresentativeData(new AbortController().signal,fetcher)).rejects.toThrow('התקבלו נתונים לא תקינים');
  });
  it('propagates a network failure rather than presenting an empty successful queue',async()=>{
    const fetcher=vi.fn().mockRejectedValue(new TypeError('Network unavailable'));
    await expect(loadRepresentativeData(new AbortController().signal,fetcher)).rejects.toThrow('Network unavailable');
  });
});

describe('waiting time and the 30-minute threshold', () => {
  it('labels elapsed time in natural Hebrew', () => {
    expect(durationLabel(20_000)).toBe('פחות מדקה');
    expect(durationLabel(60_000)).toBe('דקה');
    expect(durationLabel(12 * 60_000)).toBe('12 דקות');
    expect(durationLabel(60 * 60_000)).toBe('שעה');
    expect(durationLabel(65 * 60_000)).toBe('שעה ו־5 דקות');
    expect(durationLabel(121 * 60_000)).toBe('שעתיים ו־דקה');
    expect(durationLabel(5 * 60 * 60_000)).toBe('5 שעות');
    expect(durationLabel(50 * 60 * 60_000)).toBe('יומיים');
    expect(durationLabel(-5000)).toBe('פחות מדקה');
  });
  it('shows waiting time for unanswered requests and response time for answered ones', () => {
    expect(waitingText(item(), NOW)).toBe('ממתינה 12 דקות');
    expect(waitingText(item({ status: 'claimed', requested_at: minutesAgo(45) }), NOW)).toBe('ממתינה 45 דקות');
    expect(waitingText(item({ status: 'answered', requested_at: minutesAgo(90), answered_at: minutesAgo(50) }), NOW)).toBe('נענתה אחרי 40 דקות');
  });
  it('marks unanswered requests older than 30 minutes, and never answered ones', () => {
    expect(isOverdue(item({ requested_at: minutesAgo(30) }), NOW)).toBe(false);
    expect(isOverdue(item({ requested_at: minutesAgo(31) }), NOW)).toBe(true);
    expect(isOverdue(item({ status: 'claimed', requested_at: minutesAgo(31) }), NOW)).toBe(true);
    expect(isOverdue(item({ status: 'answered', requested_at: minutesAgo(300), answered_at: minutesAgo(10) }), NOW)).toBe(false);
  });
  it('filters by employee name, occupation or the missing field', () => {
    expect(matchesQuery(item(), 'רחלי', 'שכר בסיס חודשי ברוטו')).toBe(true);
    expect(matchesQuery(item(), '  אזור   מכירות ', '')).toBe(true);
    expect(matchesQuery(item(), 'שכר בסיס', 'שכר בסיס חודשי ברוטו')).toBe(true);
    expect(matchesQuery(item(), 'דנה', 'שכר בסיס חודשי ברוטו')).toBe(false);
    expect(matchesQuery(item({ employee_name: null }), 'דנה', '')).toBe(false);
    expect(matchesQuery(item(), '', '')).toBe(true);
  });
});

describe('representative request card', () => {
  const render = (extra: Record<string, unknown>, now = NOW) => {
    vi.stubGlobal('React', React);
    const request = requestSchema.parse({ id: '18eff6aa-0000-4000-8000-000000000001', conversation_id: '28eff6aa-0000-4000-8000-000000000001',
      status: 'claimed', topic: 'שדה חסר: שכר בסיס חודשי ברוטו [base_salary]', assigned_representative_id: '38eff6aa-0000-4000-8000-000000000001',
      requested_at: minutesAgo(12), answered_at: null, employee_name: 'רחלי כהן', occupation: 'מנהל/ת אזור מכירות', employee_id_last4: '7423', ...extra });
    return renderToStaticMarkup(React.createElement(RequestHeader, { request, field: 'base_salary', pill: null, now }));
  };
  it('shows the employee name, occupation, exact field, request number, opening time and waiting time', () => {
    const html = render({});
    for (const text of ['רחלי כהן', 'מנהל/ת אזור מכירות', 'שכר בסיס חודשי ברוטו', 'מהו שכר הבסיס החודשי ברוטו?', '#18eff6', 'ממתינה 12 דקות']) expect(html).toContain(text);
    expect(html).toContain('<time dateTime=');expect(html).not.toContain('מעל 30 דקות');
  });
  it('highlights a request waiting more than 30 minutes, and says plainly when no name is stored', () => {
    const late = render({ requested_at: minutesAgo(42) });
    expect(late).toContain('מעל 30 דקות');expect(late).toContain('ממתינה 42 דקות');expect(late).toContain('text-rose-700');
    const unnamed = render({ employee_name: null, occupation: null });
    expect(unnamed).toContain('שם לא זמין (פרטי הזהות עוד לא נשמרו)');
  });
  it('shows only the last four ID digits; never a full ID or salary even if the API sent extra fields', () => {
    const html = render({ national_id: '039337423', base_salary: 18500 } as Record<string, unknown>);
    expect(html).toContain('•••••7423');expect(html).not.toContain('039337423');expect(html).not.toContain('18500');
    expect(() => requestSchema.parse({ id: '18eff6aa-0000-4000-8000-000000000001', conversation_id: '28eff6aa-0000-4000-8000-000000000001',
      status: 'open', topic: null, assigned_representative_id: null, requested_at: minutesAgo(1), answered_at: null, employee_id_last4: '039337423' })).toThrow();
  });
  it('the full ID is not loaded or shown until the explicit action is used', () => {
    vi.stubGlobal('React', React);
    const request = requestSchema.parse({ id: '18eff6aa-0000-4000-8000-000000000001', conversation_id: '28eff6aa-0000-4000-8000-000000000001',
      status: 'claimed', topic: null, assigned_representative_id: '38eff6aa-0000-4000-8000-000000000001', requested_at: minutesAgo(5), answered_at: null });
    const html = renderToStaticMarkup(React.createElement(NationalIdReveal, { request }));
    expect(html).toContain('הצגת ת״ז מלאה');expect(html).toContain('זמין רק בזמן שהפנייה בטיפולך');expect(html).not.toMatch(/\d{9}/);
  });
});

describe('employee account area', () => {
  const props = { conversations: [], titles: {}, activeId: null, open: false, locked: false, loading: false, error: null, hasMore: false,
    onClose: () => {}, onSelect: () => {}, onLoadMore: () => {}, onRetry: () => {} };
  it('shows the stored full name and initials when the identity exists', () => {
    vi.stubGlobal('React', React);
    const html = renderToStaticMarkup(React.createElement(ChatSidebar, { ...props, account: { firstName: 'רחלי', fullName: 'רחלי כהן' } }));
    expect(html).toContain('<strong>רחלי כהן</strong>');expect(html).toContain('>רכ</span>');
    expect(initials('בת שבע בן-דוד')).toBe('בש');
  });
  it('falls back to a neutral label without a stored identity', () => {
    vi.stubGlobal('React', React);
    expect(renderToStaticMarkup(React.createElement(ChatSidebar, props))).toContain('<strong>האזור האישי שלך</strong>');
  });
});
