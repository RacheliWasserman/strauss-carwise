import { CAR_LOADER_TEXT, CarWiseCarLoader } from '../ui/carwise-car-loader';

/** Accessible loading text while the advisor prepares a reply (also read by screen readers). */
export const THINKING_TEXT = CAR_LOADER_TEXT.chat;

/** The advisor is working: the shared CarWise car loader in its chat size. Purely visual; timing and requests are unchanged. */
export function ThinkingCar() {
  return <CarWiseCarLoader variant="chat" className="cw-ai-thinking" />;
}
