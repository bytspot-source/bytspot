import { db } from '../lib/db';
import { captureError } from '../lib/observability';

/** The UTC calendar day of `at`, as stored in user_active_days.day. */
export function activeDayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

type Writer = (userId: string, day: string) => Promise<unknown>;

const writeActiveDay: Writer = (userId, day) => db.$executeRaw`
  INSERT INTO "user_active_days" ("user_id", "day") VALUES (${userId}, ${day}::date)
  ON CONFLICT DO NOTHING`;

/**
 * Remembers which members were already written today, so a signed-in request
 * costs a database write at most once per member per day on each instance.
 */
export function createActivityRecorder(write: Writer = writeActiveDay, maxRemembered = 50_000) {
  let today = '';
  const seen = new Set<string>();
  return function noteActive(userId: string | null | undefined, at = new Date()): void {
    if (!userId) return;
    const day = activeDayOf(at);
    if (day !== today || seen.size >= maxRemembered) { today = day; seen.clear(); }
    if (seen.has(userId)) return;
    seen.add(userId);
    // A failed write is not retried until the next day, so a broken row cannot fill Sentry.
    write(userId, day).catch((err) => captureError(err, { route: 'activity' }));
  };
}

/** Records that the member used the app today. Never throws or delays the request. */
export const noteActive = createActivityRecorder();
