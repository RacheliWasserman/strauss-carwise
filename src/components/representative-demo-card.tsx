// Intentionally public demo credentials, supplied and approved for display by the project owner.
// This card grants no role: normal authentication and the server's existing permissions still apply.
export const REPRESENTATIVE_DEMO_LOGIN = { email: 'carwise.rep2@example.com', password: 'rep12345' } as const;

export function RepresentativeDemoCard({ onFill, disabled }: { onFill: () => void; disabled: boolean }) {
  return <aside className="auth-demo-card" aria-labelledby="auth-demo-title">
    <span className="auth-demo-tag">לבוחני ההאקתון</span>
    <h2 id="auth-demo-title">כניסת נציג — סביבת הדגמה</h2>
    <p>רוצים להתנסות גם בצד של הנציג? היכנסו עם פרטי הדמו ובדקו כיצד מטפלים בפניות של עובדים.</p>
    <dl>
      <div><dt>אימייל</dt><dd><bdi dir="ltr">{REPRESENTATIVE_DEMO_LOGIN.email}</bdi></dd></div>
      <div><dt>סיסמה</dt><dd><bdi dir="ltr">{REPRESENTATIVE_DEMO_LOGIN.password}</bdi></dd></div>
    </dl>
    <button type="button" disabled={disabled} onClick={onFill}>מילוי פרטי נציג לדמו</button>
    <small>המילוי אינו מבצע התחברות. להמשך, לחצו על ״התחברות״ בטופס.</small>
  </aside>;
}
