'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getHebrewAuthError } from '@/lib/auth-errors';
import { createSupabaseBrowserClient } from '@/lib/supabase-browser';

type AuthFormProps = {
  mode: 'login' | 'register';
  initialError?: string;
};

export function AuthForm({ mode, initialError = '' }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);
  const isRegister = mode === 'register';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    setMessage('');

    try {
      const supabase = createSupabaseBrowserClient();

      if (isRegister) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`
          }
        });

        if (signUpError) {
          setError(getHebrewAuthError(signUpError.message));
        } else if (data.session) {
          router.replace('/');
          router.refresh();
        } else {
          setMessage('נשלח אליכם אימייל לאישור החשבון. לאחר האישור תוכלו להתחבר.');
        }
      } else {
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
      setError('לא ניתן להתחבר כרגע. בדקו את החיבור ונסו שוב.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell" dir="rtl">
      <section className="auth-panel">
        <div className="auth-mark">STRAUSS <span>CARWISE</span></div>
        <p className="auth-eyebrow">גישה מאובטחת לעובדי שטראוס</p>
        <h1>{isRegister ? 'פתיחת חשבון' : 'ברוכה הבאה'}</h1>
        <p className="auth-intro">
          {isRegister
            ? 'צרו חשבון באמצעות כתובת האימייל שלכם.'
            : 'התחברו כדי להמשיך ליועץ הרכב וההטבות.'}
        </p>

        <form onSubmit={submit} className="auth-form">
          <label>
            <span>כתובת אימייל</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              dir="ltr"
              value={email}
              onChange={event => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            <span>סיסמה</span>
            <input
              type="password"
              name="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              dir="ltr"
              minLength={8}
              value={password}
              onChange={event => setPassword(event.target.value)}
              required
            />
          </label>

          {error && <p className="auth-alert auth-error" role="alert">{error}</p>}
          {message && <p className="auth-alert auth-success" role="status">{message}</p>}

          <button className="auth-submit" type="submit" disabled={pending}>
            {pending
              ? 'רגע...'
              : isRegister
                ? 'יצירת חשבון'
                : 'התחברות'}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? 'כבר יש לכם חשבון?' : 'עדיין אין לכם חשבון?'}{' '}
          <Link href={isRegister ? '/login' : '/register'}>
            {isRegister ? 'להתחברות' : 'פתיחת חשבון'}
          </Link>
        </p>
      </section>
      <aside className="auth-aside" aria-hidden="true">
        <span className="auth-aside-label">STRAUSS BENEFITS</span>
        <p>בחירה חכמה מתחילה<br />בנתונים שלך.</p>
        <div className="auth-aside-rule" />
      </aside>
    </main>
  );
}