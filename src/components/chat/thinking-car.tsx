/** Accessible loading text while the advisor prepares a reply (also read by screen readers). */
export const THINKING_TEXT = 'CarWise בדרך עם תשובה...';

/**
 * A small CarWise car driving back and forth while the advisor is working. Pure SVG and CSS: the car drives to
 * the end of its short road, turns around and drives back. The road has a fixed size, so the chat layout never
 * moves; with prefers-reduced-motion the car stands still. Purely visual: timing and requests are unchanged.
 */
export function ThinkingCar() {
  return <div className="cw-ai-thinking" role="status" aria-live="polite">
    <span className="cw-drive" aria-hidden="true">
      <span className="cw-drive-road" />
      <span className="cw-drive-car">
        <span className="cw-drive-turn">
          <svg viewBox="0 0 48 26" width="40" height="22" focusable="false">
            <path className="cw-drive-body" d="M4 18.5V14c0-1.6 1-2.8 2.5-3.2l5.2-1.4 5.6-5.2C18.4 3.2 19.8 2.6 21.3 2.6h9.4c1.6 0 3.1.7 4.1 2l4.3 5.3 3.6 1.1c1.6.5 2.7 2 2.7 3.7v3.8c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8Z" />
            <path className="cw-drive-glass" d="M14.6 9.5 19.5 5c.5-.4 1.1-.6 1.8-.6h4.1v5.1Zm13.2 0V4.4h2.7c.9 0 1.7.4 2.3 1.1l3.3 4Z" />
            <rect className="cw-drive-light" x="41.6" y="12.6" width="2.6" height="2" rx="1" />
            <g className="cw-drive-wheel" transform="translate(13 19.5)"><circle r="4.2" /><path d="M-2.4 0h4.8M0-2.4v4.8" /></g>
            <g className="cw-drive-wheel" transform="translate(35 19.5)"><circle r="4.2" /><path d="M-2.4 0h4.8M0-2.4v4.8" /></g>
          </svg>
        </span>
      </span>
    </span>
    <span className="cw-thinking-text">{THINKING_TEXT}</span>
  </div>;
}
