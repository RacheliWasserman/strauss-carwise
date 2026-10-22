/**
 * Client-side latency diagnostics for the chat: durations only, never message content or identifiers.
 * Each phase is recorded as a `carwise:<phase>` entry in the browser's Performance panel, and in development
 * also logged as `[carwise.chat.timing]`. One turn runs at a time (sending and replies are locked), so fixed
 * keys are enough.
 *   message_saved     Send → the employee's message is saved.
 *   assistant_request The reply request: network plus server (its phases are in the Server-Timing header).
 *   reply_render      The reply arrived → it is fully visible on screen (frontend only).
 *   reply_on_screen   Send → the reply is fully visible: what the employee experiences.
 */
type Phase = 'message_saved' | 'assistant_request' | 'reply_render' | 'reply_on_screen';
const starts = new Map<Phase, number>();

export const chatTiming = {
  start(...phases: Phase[]) {
    if (typeof performance === 'undefined') return;
    const now = performance.now();
    for (const phase of phases) starts.set(phase, now);
  },
  cancel(...phases: Phase[]) { for (const phase of phases) starts.delete(phase); },
  end(phase: Phase) {
    const start = starts.get(phase);
    if (start === undefined || typeof performance === 'undefined') return;
    starts.delete(phase);
    const duration = performance.now() - start;
    try { performance.measure(`carwise:${phase}`, { start, duration }); } catch { /* Older browsers: the log below is enough. */ }
    if (process.env.NODE_ENV !== 'production') console.info('[carwise.chat.timing]', { phase, ms: Math.round(duration) });
  }
};
