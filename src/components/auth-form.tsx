'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getHebrewAuthError } from '@/lib/auth-errors';
import { AuthAside } from './auth-visuals';
import { BrandLockup } from './brand/brand-lockup';
import { CarWiseCarLoader } from './ui/carwise-car-loader';

type AuthFormProps = {
  mode: 'login' | 'register';
  initialError?: string;
};

async function readJson(response: Response): Promise<{ status?: string; message?: string; error?: string }> {
  try { return await response.json(); } catch { return {}; }
}

/** A password field with a show/hide toggle. The value is always left to right; the label stays right to left. */
export function PasswordField({ value, onChange, autoComplete }: { value: string; onChange: (value: string) => void; autoComplete: string }) {
  const [visible, setVisible] = useState(false);
  return <label>
    <span>סיסמה</span>
    <span className="auth-password">
      <input type={visible ? 'text' : 'password'} name="password" autoComplete={autoComplete} dir="ltr" minLength={8}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} value={value} onChange={event => onChange(event.target.value)} required />
      <button type="button" className="auth-reveal" onClick={() => setVisible(shown => !shown)}
        aria-label={visible ? 'הסתרת הסיסמה' : 'הצגת הסיסמה'} aria-pressed={visible}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" />
          {visible && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </span>
  </label>;
}

export function AuthForm({ mode, initialError = '' }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);
  const isRegister = mode === 'register';

  async function register() {
    // The same rules are enforced again on the server; this only gives immediate feedback. Loaded on submit, so the
    // validation library is not part of the page's first load.
    const { firstIssue, registrationSchema } = await import('@/lib/identity/employee-identity');
    const parsed = registrationSchema.safeParse({ email, password, firstName, lastName, nationalId });
    if (!parsed.success) { setError(firstIssue(parsed.error)); return; }
    const response = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ email, password, firstName, lastName, nationalId })
    });
    const data = await readJson(response);
    if (response.ok && data.status === 'signed_in') { router.replace('/'); router.refresh(); return; }
    if (response.ok) { setNationalId(''); setPassword(''); setMessage(data.message ?? 'נשלח אימייל לאישור החשבון. אחרי האישור אפשר להתחבר.'); return; }
    if (response.status === 202) { setMessage(data.error ?? ''); return; }
    setError(data.error ?? 'ההרשמה לא הושלמה. אפשר לנסות שוב.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    setMessage('');

    try {
      if (isRegister) {
        await register();
      } else {
        // Loaded on submit: the Supabase browser SDK is not needed to show the page.
        const { createSupabaseBrowserClient } = await import('@/lib/supabase-browser');
        const supabase = createSupabaseBrowserClient();
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password
        });

        if (signInError) {
          setError(getHebrewAuthError(signInError.message));
        } else {
          router.replace('/');
          router.refresh();
        }
      }
    } catch {
      setError('לא ניתן להתחבר כרגע. כדאי לבדוק את החיבור ולנסות שוב.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell" dir="rtl">
      <section className={isRegister ? 'auth-panel auth-panel-compact' : 'auth-panel'}>
        <BrandLockup tone="dark" size="sm" className="auth-panel-brand" />
        <p className="auth-eyebrow">גישה מאובטחת לעובדי שטראוס</p>
        <h1>{isRegister ? 'פתיחת חשבון' : 'ברוכים הבאים'}</h1>
        <p className="auth-intro">
          {isRegister
            ? 'פותחים חשבון עם השם, מספר תעודת הזהות וכתובת האימייל.'
            : 'מתחברים כדי להמשיך ליועץ הרכב וההטבות.'}
        </p>

        {/* The first focus in the form starts loading what submitting needs, so the click itself does not wait. */}
        <form onSubmit={submit} className="auth-form" noValidate={isRegister} aria-busy={pending}
          onFocusCapture={() => { void (isRegister ? import('@/lib/identity/employee-identity') : import('@/lib/supabase-browser')).catch(() => undefined); }}>
          {isRegister && <>
            <div className="auth-row">
              <label>
                <span>שם פרטי</span>
                <input type="text" name="given-name" autoComplete="given-name" dir="auto" maxLength={60}
                  value={firstName} onChange={event => setFirstName(event.target.value)} required />
              </label>
              <label>
                <span>שם משפחה</span>
                <input type="text" name="family-name" autoComplete="family-name" dir="auto" maxLength={60}
                  value={lastName} onChange={event => setLastName(event.target.value)} required />
              </label>
            </div>
            <label>
              <span>מספר תעודת זהות</span>
              <input type="text" name="national-id" inputMode="numeric" autoComplete="off" dir="ltr" maxLength={12}
                value={nationalId} onChange={event => setNationalId(event.target.value)} aria-describedby="auth-id-help" required />
              <small id="auth-id-help" className="auth-help">9 ספרות כולל ספרת ביקורת. נשמר בחשבון בלבד: לא מוצג לנציגים ולא נשלח למערכות בינה מלאכותית.</small>
            </label>
          </>}
          <label>
            <span>כתובת אימייל</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              dir="ltr"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={event => setEmail(event.target.value)}
              required
            />
          </label>
          <PasswordField value={password} onChange={setPassword} autoComplete={isRegister ? 'new-password' : 'current-password'} />

          {error && <p className="auth-alert auth-error" role="alert">{error}</p>}
          {message && <p className="auth-alert auth-success" role="status">{message}</p>}

          <button className="auth-submit" type="submit" disabled={pending}>
            {pending
              ? <CarWiseCarLoader variant="auth" label={isRegister ? 'יוצרים את החשבון...' : 'מתחברים...'} />
              : isRegister
                ? 'יצירת חשבון'
                : 'התחברות'}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? 'כבר יש חשבון?' : 'עדיין אין חשבון?'}{' '}
          <Link href={isRegister ? '/login' : '/register'}>
            {isRegister ? 'להתחברות' : 'פתיחת חשבון'}
          </Link>
        </p>
      </section>
      <AuthAside />
    </main>
  );
}
