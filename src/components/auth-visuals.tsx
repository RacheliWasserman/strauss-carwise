import { BrandLockup } from './brand/brand-lockup';
import { CarShape } from './ui/carwise-car-loader';

/**
 * The deep-green side of the sign-in pages: the co-branded lockup, the headline and a gentle car on a road
 * (CSS only; it stands still with prefers-reduced-motion). On phones it becomes a compact header above the form.
 * Decorative only: the form has its own heading.
 */
export function AuthAside({ headline = 'בחירה חכמה מתחילה בנתונים הנכונים.' }: { headline?: string }) {
  return <aside className="auth-aside" aria-hidden="true">
    <span className="auth-aside-petals" />
    <BrandLockup tone="light" className="auth-aside-brand" />
    <p className="auth-aside-headline">{headline}</p>
    <div className="auth-road">
      <span className="auth-road-hills" />
      <span className="auth-road-strip"><span className="auth-road-lane" /></span>
      <span className="auth-road-car"><CarShape /></span>
    </div>
  </aside>;
}
