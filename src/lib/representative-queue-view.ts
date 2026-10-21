/**
 * Presentation rules for the representative queue: waiting time, the overdue threshold and filtering.
 * Pure functions, so the screen can re-render the elapsed time every few seconds from a local clock
 * without asking the server again.
 */
export const OVERDUE_MINUTES = 30;
export type QueueStatus = 'open' | 'claimed' | 'answered' | 'closed' | 'cancelled';
export type QueueItem = { status: QueueStatus; requested_at: string; answered_at: string | null; employee_name?: string | null;
  occupation?: string | null; topic: string | null; assigned_representative_id: string | null };

/** "פחות מדקה", "12 דקות", "שעה ו־5 דקות", "שעתיים", "3 ימים". */
export function durationLabel(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return 'פחות מדקה';
  if (minutes < 60) return minutes === 1 ? 'דקה' : `${minutes} דקות`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    const head = hours === 1 ? 'שעה' : hours === 2 ? 'שעתיים' : `${hours} שעות`;
    return rest ? `${head} ו־${rest === 1 ? 'דקה' : `${rest} דקות`}` : head;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'יום' : days === 2 ? 'יומיים' : `${days} ימים`;
}

const waiting = (item: QueueItem) => item.status === 'open' || item.status === 'claimed';

/** "ממתינה 12 דקות" while unanswered; "נענתה אחרי 40 דקות" once answered. */
export function waitingText(item: QueueItem, now: number): string {
  const requested = Date.parse(item.requested_at);
  if (!Number.isFinite(requested)) return '';
  if (waiting(item)) return `ממתינה ${durationLabel(now - requested)}`;
  const answered = item.answered_at ? Date.parse(item.answered_at) : NaN;
  return Number.isFinite(answered) ? `נענתה אחרי ${durationLabel(answered - requested)}` : '';
}

/** Unanswered for more than 30 minutes. */
export const isOverdue = (item: QueueItem, now: number) =>
  waiting(item) && now - Date.parse(item.requested_at) > OVERDUE_MINUTES * 60_000;

export type QueueFilter = { query: string; view: 'all' | 'waiting' | 'mine' | 'done' };
/** Search by employee name, occupation or the missing field's wording; whitespace and case are ignored. */
export function matchesQuery(item: QueueItem, query: string, fieldLabel: string) {
  const needle = query.trim().toLocaleLowerCase('he-IL').replace(/\s+/g, ' ');
  if (!needle) return true;
  return [item.employee_name, item.occupation, fieldLabel, item.topic].some(value => value?.toLocaleLowerCase('he-IL').replace(/\s+/g, ' ').includes(needle));
}
