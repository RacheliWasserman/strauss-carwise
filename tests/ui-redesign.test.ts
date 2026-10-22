import * as React from 'react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...rest }, children) }));
vi.mock('@/lib/supabase-browser', () => ({ createSupabaseBrowserClient: () => ({}) }));
vi.mock('@/lib/auth-errors', () => ({ getHebrewAuthError: (message: string) => message }));
vi.mock('@/lib/identity/employee-identity', async () => import('../src/lib/identity/employee-identity'));
vi.mock('@/components/logout-button', () => ({ LogoutButton: () => null }));
import { CAR_LOADER_TEXT, CarWiseCarLoader, type CarLoaderVariant } from '../src/components/ui/carwise-car-loader';
import { BrandLockup } from '../src/components/brand/brand-lockup';
import { AuthForm, PasswordField } from '../src/components/auth-form';
import { RepresentativeConsole, RequestCard } from '../src/components/representative/representative-console';

afterEach(() => vi.unstubAllGlobals());
const render = (element: React.ReactElement) => { vi.stubGlobal('React', React); return renderToStaticMarkup(element); };
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const SOURCES = files('src').filter(path => /\.(tsx?|css)$/.test(path));
const read = (path: string) => readFileSync(path, 'utf8');

describe('CarWiseCarLoader replaces every circular spinner', () => {
  it('has a variant for every loading context, each with Hebrew text and a decorative car', () => {
    expect(CAR_LOADER_TEXT.chat).toBe('CarWise בודק את הנתונים...');
    expect(CAR_LOADER_TEXT.payslip).toBe('קוראים את התלוש...');
    for (const variant of Object.keys(CAR_LOADER_TEXT) as CarLoaderVariant[]) {
      const html = render(React.createElement(CarWiseCarLoader, { variant }));
      expect(html).toContain(CAR_LOADER_TEXT[variant]);
      expect(html).toMatch(/class="cw-drive cw-drive-(sm|md|lg)" aria-hidden="true"/);
      // A live region everywhere except inside buttons, where the text is the button's own label.
      if (variant === 'button' || variant === 'auth') expect(html).not.toContain('role="status"');
      else expect(html).toContain('role="status"');
    }
    expect(render(React.createElement(CarWiseCarLoader, { variant: 'inline', label: 'בטעינה…' }))).toContain('בטעינה…');
  });
  it('the only circular spinner is the main composer send/save button', () => {
    for (const path of SOURCES) {
      if (/chat[\\/](chat-composer\.tsx|employee-chat\.css)$/.test(path)) continue;
      expect(read(path), path).not.toMatch(/cw-spinner|animate-spin|@keyframes cw-spin\b|rotate\(360deg\)/);
    }
    const composer = read('src/components/chat/chat-composer.tsx');
    expect(composer.match(/cw-spinner/g)).toHaveLength(1);
    expect(composer).toContain('{props.sending ? <i className="cw-spinner" aria-hidden="true" /> : <ChatIcon');
    expect(composer).not.toContain('CarWiseCar');
    // Scoped to the send button; with reduced motion every animation in the chat app is switched off.
    const css = read('src/components/chat/employee-chat.css');
    expect(css.match(/cw-spinner/g)).toHaveLength(1);
    expect(css).toMatch(/\.cw-send \.cw-spinner \{[^}]*animation: cw-spin/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.cw-app \*, [^{]*\{ animation: none !important;/);
    // AI thinking keeps the car.
    expect(read('src/components/chat/thinking-car.tsx')).toContain('<CarWiseCarLoader variant="chat"');
  });
  it('stands still with prefers-reduced-motion', () => {
    expect(read('src/components/ui/carwise-car-loader.css')).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.cw-drive-car, \.cw-drive-turn, \.cw-drive \.cw-drive-turn svg \{ animation: none; transform: none; \}/);
  });
  it('is used by chat, payslip reading, sign-in, the catalog and the representative screens', () => {
    expect(read('src/components/chat/payslip-upload.tsx')).toContain('<CarWiseCarLoader variant="payslip" />');
    expect(read('src/components/chat/employee-chat.tsx')).toContain('<CarWiseCarLoader variant="page" />');
    expect(read('src/components/auth-form.tsx')).toContain('<CarWiseCarLoader variant="auth"');
    expect(read('src/app/catalog/loading.tsx')).toContain('<CarWiseCarLoader variant="catalog" />');
    expect(read('src/components/representative/representative-console.tsx')).toContain('<CarWiseCarLoader variant="representative"');
  });
});

describe('CarWise brand: the original W mark', () => {
  it('uses the original CarWiseMark (W) beside the LTR wordmark, never the Strauss flower', () => {
    const html = render(React.createElement(BrandLockup, { tone: 'light' }));
    expect(html).toMatch(/^<span class="cw-lockup cw-lockup-light cw-lockup-md"><span class="cw-mark " aria-hidden="true"><svg viewBox="0 0 40 40"/);
    expect(html).toContain('<span class="cw-lockup-words" dir="ltr"><span class="cw-lockup-name">CarWise<span>.</span></span>');
    expect(html).not.toMatch(/flower|<img/);
    expect(render(React.createElement(BrandLockup, { tone: 'dark', size: 'sm' }))).toContain('class="cw-mark cw-mark-small"');
  });
  it('the same brand is used in the sidebar, sign-in pages and representative header; the flower asset is gone', () => {
    expect(read('src/components/chat/chat-sidebar.tsx')).toContain('<BrandLockup tone="light" />');
    expect(read('src/components/auth-form.tsx')).toContain('<BrandLockup tone="dark" size="sm"');
    expect(read('src/components/auth-visuals.tsx')).toContain('<BrandLockup tone="light"');
    expect(read('src/app/representative/page.tsx')).toContain('<BrandLockup tone="light" size="sm" />');
    for (const path of SOURCES) expect(read(path), path).not.toContain('strauss-flower');
    expect(existsSync('public/brand/strauss-flower.svg')).toBe(false);
    // The mark is styled globally so it renders outside the chat too.
    expect(read('src/app/globals.css')).toMatch(/\.cw-mark \{ width: 45px; height: 45px;/);
  });
});

describe('homepage petal watermark', () => {
  it('uses only green, mint, teal and pale-blue tones (no red or orange)', () => {
    const svg = read('public/brand/petal-watermark.svg');
    const colours = [...new Set(svg.match(/#[0-9a-f]{6}/g))];
    expect(colours.length).toBeGreaterThan(3);
    for (const colour of colours) {
      const [r, g, b] = [1, 3, 5].map(index => parseInt(colour.slice(index, index + 2), 16));
      expect(g, colour).toBeGreaterThan(r); // green or blue dominant, never red/orange
      expect(Math.max(g, b), colour).toBeGreaterThan(180); // pale
    }
  });
  it('is decorative, ignores the pointer and sits behind the welcome content', () => {
    expect(read('src/components/chat/employee-chat.tsx')).toContain('<span className="cw-petal-watermark" aria-hidden="true">');
    const css = read('src/components/chat/employee-chat.css');
    expect(css).toMatch(/\.cw-petal-watermark \{[^}]*pointer-events: none;[^}]*z-index: 0;/);
    expect(css).toMatch(/\.cw-welcome-scroll, [^{]*\{ position: relative; z-index: 1; \}/);
  });
});

describe('sign-in and registration', () => {
  it('login: split screen with the green brand panel, no prefilled email, LTR email and password', () => {
    const html = render(React.createElement(AuthForm, { mode: 'login' }));
    expect(html).toContain('<aside class="auth-aside" aria-hidden="true">');
    expect(html).toContain('בחירה חכמה מתחילה בנתונים הנכונים.');
    expect(html).toMatch(/<input type="email" autoComplete="email" dir="ltr"[^>]*value=""\/>/);
    expect(html).toMatch(/<input type="password" autoComplete="current-password" dir="ltr"/);
    // The owner explicitly approved this public demo account; real account credentials are never prefilled.
    expect(html).toContain('carwise.rep2@example.com');
    expect(html).toContain('כניסת נציג — סביבת הדגמה');
  });
  it('the password field has a labelled show/hide toggle', () => {
    const html = render(React.createElement(PasswordField, { value: '', onChange: () => undefined, autoComplete: 'new-password' }));
    expect(html).toContain('aria-label="הצגת הסיסמה"');expect(html).toContain('aria-pressed="false"');expect(html).toContain('type="button"');
  });
  it('registration keeps the identity fields and their privacy note', () => {
    const html = render(React.createElement(AuthForm, { mode: 'register' }));
    for (const text of ['שם פרטי', 'שם משפחה', 'מספר תעודת זהות', 'לא מוצג לנציגים', 'יצירת חשבון']) expect(html).toContain(text);
    expect(html).toContain('autoComplete="new-password"');
  });
});

describe('dialogs and placeholders', () => {
  it('modal dialogs are centred (Tailwind preflight resets the native margin)', () => {
    expect(read('src/app/globals.css')).toMatch(/:where\(dialog:modal\)\{position:fixed;inset:0;margin:auto;/);
  });
  it('Hebrew placeholders start on the right; LTR values keep their direction', () => {
    const css = read('src/app/globals.css');
    expect(css).toMatch(/input\[dir="auto"\]:placeholder-shown,textarea\[dir="auto"\]:placeholder-shown,\.cw-placeholder-rtl:placeholder-shown\{direction:rtl;text-align:right/);
    expect(read('src/components/chat/chat-composer.tsx')).toMatch(/placeholder="מה תרצו לדעת\?[^"]*" dir="auto"/);
    expect(read('src/components/chat/payslip-review-row.tsx')).toContain('className="cw-placeholder-rtl" inputMode="decimal" dir="ltr"');
    // No global RTL on LTR fields.
    expect(css).not.toMatch(/input\[dir="ltr"\][^{]*\{[^}]*direction:rtl/);
  });
});

describe('compact representative dashboard', () => {
  it('counters are compact status filters (existing statuses only) and loading uses the car', () => {
    const html = render(React.createElement(RepresentativeConsole, { userId: '38eff6aa-0000-4000-8000-000000000001' }));
    for (const label of ['הכול', 'ממתינות', 'בטיפולי', 'טופלו על ידי']) expect(html).toContain(label);
    expect(html.match(/aria-pressed="(true|false)"/g)).toHaveLength(4);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(CAR_LOADER_TEXT.representative);
    expect(html).not.toContain('<select');
  });
  it('a card opens and closes on its own; collapsed, its details (and the ID control) are not shown', () => {
    const html = render(React.createElement(RequestCard, { accent: 'border-sky-500', header: React.createElement('p', null, 'כותרת'), toggleLabel: 'מענה לפנייה',
      revealable: React.createElement('span', null, 'REVEAL'), children: React.createElement('p', null, 'טופס') }));
    expect(html).toContain('aria-expanded="false"');expect(html).toContain('מענה לפנייה');
    expect(html).toMatch(/<div id="[^"]+" hidden="" /);
    expect(html).not.toContain('REVEAL');
  });
});

describe('catalog: owner-supplied AI illustrations', () => {
  it('all 20 illustrations decode at their original proportions, including MG4', async () => {
    const sharp = (await import('sharp')).default;
    const { VEHICLE_PHOTOS } = await import('../src/lib/catalog/vehicle-media');
    expect(Object.keys(VEHICLE_PHOTOS)).toHaveLength(20);
    expect(VEHICLE_PHOTOS['CAR-06'].src).toContain('CAR-06_MG4');
    for (const photo of Object.values(VEHICLE_PHOTOS)) {
      const { info } = await sharp(`public${photo.src}`).raw().toBuffer({ resolveWithObject: true });
      expect(info.width).toBeGreaterThanOrEqual(500);
      expect(info.height).toBeGreaterThanOrEqual(500);
      expect(photo.kind).toBe('ai-illustration');
    }
  });
});
