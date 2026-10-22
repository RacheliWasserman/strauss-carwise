/**
 * CarWise's one loading indicator: a small car that drives to the end of a fixed-size road, turns around and drives
 * back. It replaces every circular spinner. Pure SVG and CSS (carwise-car-loader.css, loaded by the root layout), so
 * it renders the same on the server and the client; with prefers-reduced-motion the car stands still.
 *
 * Each variant sets the size and the default Hebrew text. The text is always rendered, so screen readers hear it;
 * inside a button (`button`, `auth`) it is the button's own label and no extra live region is created.
 */
export type CarLoaderVariant = 'page' | 'inline' | 'button' | 'modal' | 'chat' | 'auth' | 'catalog' | 'representative' | 'payslip';

const VARIANTS: Record<CarLoaderVariant, { size: 'sm' | 'md' | 'lg'; layout: 'stack' | 'row' | 'button'; text: string }> = {
  page: { size: 'lg', layout: 'stack', text: 'המרחב האישי נפתח...' },
  inline: { size: 'md', layout: 'row', text: 'בטעינה...' },
  button: { size: 'sm', layout: 'button', text: 'רגע...' },
  modal: { size: 'lg', layout: 'stack', text: 'רגע...' },
  chat: { size: 'md', layout: 'row', text: 'CarWise בודק את הנתונים...' },
  auth: { size: 'sm', layout: 'button', text: 'רגע...' },
  catalog: { size: 'lg', layout: 'stack', text: 'קטלוג הרכבים נטען...' },
  representative: { size: 'md', layout: 'row', text: 'הפניות נטענות...' },
  payslip: { size: 'lg', layout: 'stack', text: 'קוראים את התלוש...' }
};

export const CAR_LOADER_TEXT = Object.fromEntries(Object.entries(VARIANTS).map(([key, value]) => [key, value.text])) as Record<CarLoaderVariant, string>;

/** The CarWise car itself (decorative SVG, styled by the cw-drive-* classes). */
export function CarShape({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 48 26" focusable="false" aria-hidden="true">
    <path className="cw-drive-body" d="M4 18.5V14c0-1.6 1-2.8 2.5-3.2l5.2-1.4 5.6-5.2C18.4 3.2 19.8 2.6 21.3 2.6h9.4c1.6 0 3.1.7 4.1 2l4.3 5.3 3.6 1.1c1.6.5 2.7 2 2.7 3.7v3.8c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8Z" />
    <path className="cw-drive-glass" d="M14.6 9.5 19.5 5c.5-.4 1.1-.6 1.8-.6h4.1v5.1Zm13.2 0V4.4h2.7c.9 0 1.7.4 2.3 1.1l3.3 4Z" />
    <rect className="cw-drive-light" x="41.6" y="12.6" width="2.6" height="2" rx="1" />
    <g className="cw-drive-wheel" transform="translate(13 19.5)"><circle r="4.2" /><path d="M-2.4 0h4.8M0-2.4v4.8" /></g>
    <g className="cw-drive-wheel" transform="translate(35 19.5)"><circle r="4.2" /><path d="M-2.4 0h4.8M0-2.4v4.8" /></g>
  </svg>;
}

/** The car on its road only (decorative). */
export function CarWiseCar({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`cw-drive cw-drive-${size}`} aria-hidden="true">
    <span className="cw-drive-road" />
    <span className="cw-drive-car">
      <span className="cw-drive-turn">
        <CarShape />
      </span>
    </span>
  </span>;
}

export function CarWiseCarLoader({ variant = 'inline', label, className = '' }: { variant?: CarLoaderVariant; label?: string; className?: string }) {
  const { size, layout, text } = VARIANTS[variant];
  const classes = `cw-loader cw-loader-${layout} cw-loader-${variant}${className ? ` ${className}` : ''}`;
  const content = <><CarWiseCar size={size} /><span className="cw-loader-text">{label ?? text}</span></>;
  if (layout === 'button') return <span className={classes}>{content}</span>;
  return <div className={classes} role="status" aria-live="polite">{content}</div>;
}
