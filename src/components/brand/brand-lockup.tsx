import { CarWiseMark } from '../chat/chat-icon';

/**
 * The CarWise brand: the original W mark (CarWiseMark, the same icon the chat uses) beside the "CarWise." wordmark
 * and "BY STRAUSS". Used everywhere the brand appears (sidebar, sign-in pages, representative header). The mark comes
 * first, so in the RTL interface it sits on the right as it always has; the English wordmark is kept left to right.
 */
export function BrandLockup({ tone = 'light', size = 'md', className = '' }: { tone?: 'light' | 'dark'; size?: 'sm' | 'md'; className?: string }) {
  return <span className={`cw-lockup cw-lockup-${tone} cw-lockup-${size}${className ? ` ${className}` : ''}`}>
    <CarWiseMark small={size === 'sm'} />
    <span className="cw-lockup-words" dir="ltr">
      <span className="cw-lockup-name">CarWise<span>.</span></span>
      <span className="cw-lockup-caption">BY STRAUSS</span>
    </span>
  </span>;
}
