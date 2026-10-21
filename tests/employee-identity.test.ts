import * as React from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityInputSchema, isValidIsraeliId, maskIsraeliId, needsProfileCompletion, normalizeIsraeliId, registrationSchema } from '../src/lib/identity/employee-identity';
import { greeting, greetingName } from '../src/lib/identity/greeting';
import { THINKING_TEXT, ThinkingCar } from '../src/components/chat/thinking-car';
import { ChatWelcome } from '../src/components/chat/chat-welcome';

afterEach(() => vi.unstubAllGlobals());

describe('Israeli national ID validation', () => {
  it('accepts valid IDs, including leading zeros and shortened input', () => {
    for (const id of ['000000018', '123456782', '00018', '18 ', '039337423']) {
      if (id.trim().length < 5) { expect(isValidIsraeliId(id)).toBe(false); continue; }
      expect(isValidIsraeliId(id)).toBe(true);
    }
    expect(normalizeIsraeliId('00018')).toBe('000000018');
    expect(normalizeIsraeliId('12345-678 2')).toBe('123456782');
  });
  it('rejects wrong check digits, non-digits, wrong lengths and all zeros', () => {
    for (const id of ['123456789', '000000019', 'abcdefghi', '1234567890', '1234', '', '000000000', '12345678a', '٠٠٠٠٠٠٠١٨']) {
      expect(isValidIsraeliId(id)).toBe(false);
    }
  });
  it('masks an ID to its last two digits only', () => {
    expect(maskIsraeliId('39337423')).toBe('•••••••23');
    expect(maskIsraeliId('39337423')).not.toContain('393374');
  });
  it('validates and normalizes the identity input; the ID is stored as 9 digits', () => {
    const parsed = identityInputSchema.parse({ firstName: '  בת   שבע ', lastName: 'בן-דוד', nationalId: '39337423' });
    expect(parsed).toEqual({ firstName: 'בת שבע', lastName: 'בן-דוד', nationalId: '039337423' });
    expect(identityInputSchema.safeParse({ firstName: 'רחלי', lastName: 'כהן', nationalId: '123456789' }).success).toBe(false);
    expect(identityInputSchema.safeParse({ firstName: 'רחלי1', lastName: 'כהן', nationalId: '000000018' }).success).toBe(false);
    expect(identityInputSchema.safeParse({ firstName: '', lastName: 'כהן', nationalId: '000000018' }).success).toBe(false);
    const error = identityInputSchema.safeParse({ firstName: 'רחלי', lastName: 'כהן', nationalId: '123456789' });
    expect(JSON.stringify(error)).not.toContain('123456789'.slice(0, 6) + '"'); // The message never echoes the ID.
  });
  it('sign-up input cannot carry a role or any other extra field', () => {
    const base = { email: 'test@example.com', password: 'long-enough-1', firstName: 'רחלי', lastName: 'כהן', nationalId: '000000018' };
    expect(registrationSchema.safeParse(base).success).toBe(true);
    expect(registrationSchema.safeParse({ ...base, role: 'representative' }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...base, user_metadata: { role: 'representative' } }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
  });
  it('only a known-missing identity sends an employee to profile completion', () => {
    expect(needsProfileCompletion('missing')).toBe(true);
    expect(needsProfileCompletion('complete')).toBe(false);
    expect(needsProfileCompletion('unavailable')).toBe(false); // Migration not applied: nobody is blocked.
  });
});

describe('greeting by stored first name', () => {
  it('keeps compound first names whole and trims spacing', () => {
    expect(greetingName('  רחלי ')).toBe('רחלי');
    expect(greetingName('בת שבע')).toBe('בת שבע');
    expect(greetingName('שירה-לי')).toBe('שירה-לי');
    expect(greetingName('אנה מריה')).toBe('אנה מריה');
    expect(greetingName('דנה מרים כהן')).toBe('דנה');
    expect(greeting('רחלי')).toBe('שלום רחלי 👋');
    expect(greeting()).toBe('שלום 👋');
  });
  it('the welcome screen greets by name in neutral language', () => {
    vi.stubGlobal('React', React);
    const html = renderToStaticMarkup(React.createElement(ChatWelcome, { firstName: 'רחלי', disabled: false, onSuggest: () => {} }));
    expect(html).toContain('שלום רחלי 👋');
    expect(html).not.toMatch(/תרצי|שאת כאן|שתאשרי/u);
  });
});

describe('AI thinking indicator: the CarWise car', () => {
  it('renders an accessible status with text, a decorative car and no dots', () => {
    vi.stubGlobal('React', React);
    const html = renderToStaticMarkup(React.createElement(ThinkingCar));
    expect(THINKING_TEXT).toBe('CarWise בדרך עם תשובה...');
    expect(html).toContain('role="status"');expect(html).toContain(THINKING_TEXT);
    expect(html).toContain('class="cw-drive" aria-hidden="true"');expect(html).toContain('<svg');
    expect(html).not.toContain('<i>');
  });
  it('drives back and forth, turns around, stays inside a fixed road and stands still with reduced motion', () => {
    const css = readFileSync('src/components/chat/employee-chat.css', 'utf8');
    expect(css).toMatch(/\.cw-drive \{[^}]*width: 104px; height: 30px; overflow: hidden;/);
    expect(css).toMatch(/@keyframes cw-drive-x \{[^\n]*translateX\(62px\)[^\n]*translateX\(0\)/);
    expect(css).toMatch(/@keyframes cw-drive-turn \{[^\n]*scaleX\(-1\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.cw-drive-car, \.cw-drive-turn, \.cw-drive-turn svg \{ animation: none; transform: none; \}/);
    // The chat thread uses it instead of the old three dots.
    const thread = readFileSync('src/components/chat/chat-thread.tsx', 'utf8');
    expect(thread).toContain('{props.thinking && <ThinkingCar />}');
    expect(thread).not.toContain('<i /><i /><i /></div>}\n        {props.aiError');
  });
});

describe('database migration for identity (static review; not executed)', () => {
  const sql = readFileSync('supabase/migrations/202610210001_employee_identity.sql', 'utf8');
  it('never grants the national ID column to client roles', () => {
    const grant = sql.match(/GRANT SELECT \(([^)]*)\)\s+ON public\.advisor_employee_identities TO authenticated;/);
    expect(grant?.[1]).toBeDefined();
    expect(grant![1]).not.toContain('national_id,');expect(grant![1].split(',').map(item => item.trim())).not.toContain('national_id');
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.advisor_employee_identities FROM PUBLIC, anon, authenticated;/);
    expect(sql).not.toMatch(/GRANT [^;]*advisor_employee_identities[^;]*TO anon/);
    expect(sql).toContain('CHECK (public.advisor_is_valid_israeli_id(national_id))');
    expect(sql).toContain("RAISE EXCEPTION 'Identity already completed'");
    expect(grant![1]).not.toContain('national_id_last4');
    expect(sql).toContain('national_id_last4 text GENERATED ALWAYS AS (pg_catalog.right(national_id, 4)) STORED');
  });
  it('profile completion answers a duplicate ID with a generic error; only the caller\'s own row counts as "already completed"', () => {
    expect(sql).toContain('EXCEPTION WHEN unique_violation THEN');
    expect(sql).toContain('GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;');
    expect(sql).toMatch(/IF violated = 'advisor_employee_identities_pkey' THEN\s+RAISE EXCEPTION 'Identity already completed' USING ERRCODE = 'P0002';/);
    expect(sql).toContain("RAISE EXCEPTION 'Identity could not be saved' USING ERRCODE = 'P0001';");
    expect(sql).not.toMatch(/RAISE EXCEPTION[^;]*national_id[^;]*;/i); // No message mentions the ID.
    expect(sql).toContain('advisor_reveal_request_national_id (migration 202610210003)');
  });
  it('the ID validation function is not callable from the Data API', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.advisor_is_valid_israeli_id(text) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.advisor_is_valid_israeli_id(text) TO service_role;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.advisor_complete_employee_identity(text, text, text) FROM PUBLIC, anon, service_role;');
  });
  it('the full-ID function returns it only to the assigned representative of a claimed request, audited and generic', () => {
    const reveal = readFileSync('supabase/migrations/202610210003_representative_national_id_reveal.sql', 'utf8');
    expect(reveal).toContain('NOT public.advisor_is_current_user_representative()');
    expect(reveal).toMatch(/WHERE request\.id = p_request_id\s+AND request\.assigned_representative_id = caller\s+AND request\.status = 'claimed'\s+FOR SHARE;/);
    expect(reveal).toContain('INSERT INTO public.advisor_national_id_reveals(request_id, representative_id)');
    expect(reveal.match(/RAISE EXCEPTION '([^']+)'/g)!.filter(line => !line.includes('Apply') && !line.includes('Requires') && !line.includes('already exist'))
      .every(line => line === "RAISE EXCEPTION 'Not available'")).toBe(true);
    expect(reveal).toContain('REVOKE ALL ON FUNCTION public.advisor_reveal_request_national_id(uuid) FROM PUBLIC, anon, service_role;');
    expect(reveal).toContain('GRANT EXECUTE ON FUNCTION public.advisor_reveal_request_national_id(uuid) TO authenticated;');
    expect(reveal).toContain('REVOKE ALL ON TABLE public.advisor_national_id_reveals FROM PUBLIC, anon, authenticated;');
    expect(reveal).not.toMatch(/GRANT [^;]*advisor_employee_identities/);
  });
  it('the representative migration removes conversation and calculation reads but keeps own replies', () => {
    const rep = readFileSync('supabase/migrations/202610210002_representative_least_privilege.sql', 'utf8');
    for (const policy of ['advisor_conversations_read_owner_or_assigned_rep', 'advisor_messages_read_owner_or_assigned_rep',
      'advisor_calculation_runs_read_owner_or_assigned_rep', 'advisor_calculation_scenarios_read_owner_or_assigned_rep']) expect(rep).toContain(`DROP POLICY ${policy}`);
    expect(rep).toContain("sender_type = 'representative'\n      AND sender_user_id = (SELECT auth.uid())");
    expect(rep).not.toMatch(/CREATE POLICY advisor_calculation_runs_read_owner[\s\S]*?representative\(\)[\s\S]*?CREATE POLICY advisor_calculation_scenarios/);
  });
});

describe('employee cancels their own representative request (migration 004, static review; not executed)', () => {
  it('only the owner, only an active request, through a narrow function', () => {
    const sql = readFileSync('supabase/migrations/202610210004_employee_cancel_representative_request.sql', 'utf8');
    expect(sql).toMatch(/WHERE id = p_request_id\s+AND owner_user_id = caller\s+AND status IN \('open', 'claimed', 'answered'\)/);
    expect(sql).toContain("SET status = 'cancelled'");expect(sql).toContain('NOT public.advisor_is_current_user_employee()');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.advisor_cancel_own_representative_request(uuid) FROM PUBLIC, anon, service_role;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.advisor_cancel_own_representative_request(uuid) TO authenticated;');
    expect(sql).not.toMatch(/GRANT (?:UPDATE|INSERT|DELETE)/);
  });
});

describe('gender-neutral Hebrew in user-facing text and prompts', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  // Feminine-singular forms addressed to the user, or used by the assistant about itself.
  const FEMININE = /(?:^|[^֐-׿])(כתבי|תרצי|בחרי|לחצי|בדקי|סמני|הזיני|תקני|שלחי|נסי|התחברי|השלימי|שימי|תאשרי|תוכלי|תקבלי|תבחרי|מעדיפה|יכולה|צריכה|מפרישה|משלמת|ברוכה|עלייך|אלייך|החזירי|השתמשי|פרשי|השמיטי|תחזירי|תסיקי|תמירי|שמחה לעזור|שאת כאן|את מפרישה|את משלמת|אם את|את בודקת|שומרת|טוענת|קוראת|לוקחת|שולחת|מחשבת|פותחת|נותנת)(?=$|[^֐-׿])/u;
  // Slash forms such as בחר/י, העובד/ת, יבחר/תבחר (official occupation titles like מפתח/ת are data, not wording).
  const SLASH = /[֐-׿]\/(?:[יהת]|ת[֐-׿]+)(?![֐-׿])/u;
  // Patterns that recognise what employees write (in any gender) are not wording addressed to anyone.
  const understandsInput = /\/u\.test|\/u\)|RegExp\(|\/gu|\.match\(\/|\/u[,;]|matchAll\(|\\\\s\+/;
  it('no user-facing string, deterministic reply or prompt addresses anyone in feminine singular or with slashes', () => {
    const findings: string[] = [];
    for (const file of walk('src')) {
      if (/[\\/](types|calculator|data)\.ts$/.test(file)) continue; // Official source data keys.
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        const code = line.trim();
        if (!/[֐-׿]/u.test(code) || /^(?:\/\/|\*|\/\*)/.test(code) || understandsInput.test(code)) return;
        // Exact product copy explicitly requested for the unspecified hypothetical-simulation prompt.
        const text = code.replace(/מפתח\/ת/g, '').replace('בשמחה! מה תרצי לשנות לצורך הסימולציה — שכר, רכב או משהו אחר?', '');
        if (FEMININE.test(text) || SLASH.test(text)) findings.push(`${file}:${index + 1}: ${code.slice(0, 120)}`);
      });
    }
    expect(findings).toEqual([]);
  });
  it('the free-text reply prompt requires neutral language', async () => {
    vi.mock('server-only', () => ({}));
    const { CARWISE_SYSTEM } = await import('../src/lib/ai/config');
    expect(CARWISE_SYSTEM).toContain('שפה ניטרלית מגדרית בלבד');
    expect(CARWISE_SYSTEM).not.toMatch(/^את CarWise/u);
  });
});
