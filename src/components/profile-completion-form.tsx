'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { firstIssue, identityInputSchema } from '@/lib/identity/employee-identity';

/** One-time completion of name and national ID for accounts created before these fields were required. */
export function ProfileCompletionForm() {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const parsed = identityInputSchema.safeParse({ firstName, lastName, nationalId });
    if (!parsed.success) { setError(firstIssue(parsed.error)); return; }
    setPending(true);
    try {
      const response = await fetch('/api/profile/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ firstName, lastName, nationalId })
      });
      let data: { error?: string } = {};
      try { data = await response.json(); } catch { /* The status is enough. */ }
      if (response.ok || response.status === 409 && data.error?.includes('כבר הושלמו') || response.status === 503) {
        setNationalId('');
        router.replace('/employee');
        router.refresh();
        return;
      }
      setError(data.error ?? 'לא ניתן לשמור את הפרטים כרגע. אפשר לנסות שוב.');
    } catch {
      setError('לא ניתן לשמור את הפרטים כרגע. כדאי לבדוק את החיבור ולנסות שוב.');
    } finally { setPending(false); }
  }

  return <main className="auth-shell" dir="rtl">
    <section className="auth-panel">
      <div className="auth-mark">STRAUSS <span>CARWISE</span></div>
      <p className="auth-eyebrow">עוד צעד קטן</p>
      <h1>השלמת פרטים</h1>
      <p className="auth-intro">כדי שהיועץ יפנה אליכם בשם ולא ישאל עליו שוב, יש להשלים שם ומספר תעודת זהות. זה נעשה פעם אחת בלבד.</p>
      <form onSubmit={submit} className="auth-form" noValidate>
        <div className="auth-row">
          <label><span>שם פרטי</span>
            <input type="text" autoComplete="given-name" dir="auto" maxLength={60} value={firstName} onChange={event => setFirstName(event.target.value)} required /></label>
          <label><span>שם משפחה</span>
            <input type="text" autoComplete="family-name" dir="auto" maxLength={60} value={lastName} onChange={event => setLastName(event.target.value)} required /></label>
        </div>
        <label><span>מספר תעודת זהות</span>
          <input type="text" inputMode="numeric" autoComplete="off" dir="ltr" maxLength={12} value={nationalId}
            onChange={event => setNationalId(event.target.value)} aria-describedby="completion-id-help" required />
          <small id="completion-id-help" className="auth-help">9 ספרות, כולל ספרת ביקורת. המספר לא מוצג לנציגים ולא נשלח למערכות בינה מלאכותית.</small>
        </label>
        {error && <p className="auth-alert auth-error" role="alert">{error}</p>}
        <button className="auth-submit" type="submit" disabled={pending}>{pending ? 'רגע...' : 'שמירה והמשך'}</button>
      </form>
    </section>
    <aside className="auth-aside" aria-hidden="true">
      <span className="auth-aside-label">STRAUSS BENEFITS</span>
      <p>כמעט<br />מתחילים.</p>
      <div className="auth-aside-rule" />
    </aside>
  </main>;
}
