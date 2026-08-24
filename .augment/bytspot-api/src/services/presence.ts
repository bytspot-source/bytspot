import { getRedis } from '../lib/redis';
import { db } from '../lib/db';

/** Sliding window for "active now". Stated in the UI copy — a count without a
 *  declared window is unfalsifiable. */
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

/** Below this, a global count is noise dressed as density and is not rendered. */
export const GLOBAL_FLOOR = 15;

/** One write per user per minute is enough resolution for an hourly window. */
const WRITE_THROTTLE_MS = 60 * 1000;

const ACTIVE_KEY = 'presence:active';
const lastWrite = new Map<string, number>();

/** Record a user as active. Never throws: presence is decoration on a request
 *  that has already done its real work. */
export async function recordActive(userId: string, now = Date.now()): Promise<void> {
  const previous = lastWrite.get(userId);
  if (previous && now - previous < WRITE_THROTTLE_MS) return;
  lastWrite.set(userId, now);

  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.zadd(ACTIVE_KEY, now, userId);
    await redis.zremrangebyscore(ACTIVE_KEY, 0, now - ACTIVE_WINDOW_MS);
  } catch {
    // Redis unavailability must never surface as a failed request.
  }
}

/** Distinct users active inside the window, or null when unknowable. Null and
 *  zero are different answers and must stay distinguishable. */
export async function activeCount(now = Date.now()): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.zcount(ACTIVE_KEY, now - ACTIVE_WINDOW_MS, now);
  } catch {
    return null;
  }
}

/** Accounts that exist. A different claim from presence and labelled as one:
 *  a member is not a person who is out tonight. */
export async function memberCount(): Promise<number | null> {
  try {
    return await db.user.count({ where: { deletedAt: null } });
  } catch {
    return null;
  }
}

export type PresenceSummary =
  | { scope: 'global'; count: number }
  | { scope: 'members'; count: number }
  | { scope: 'none' };

/** The home count is everyone using the app, not the people a member knows.
 *  Who a member knows is a fact about them and belongs on their profile
 *  alongside connections and check-ins; the home header answers "is anyone
 *  here", which only a whole-app number can answer for a new arrival. */
export function resolveSummary(global: number | null, members: number | null = null): PresenceSummary {
  if (global !== null && global >= GLOBAL_FLOOR) return { scope: 'global', count: global };
  // Below the floor the honest fallback is a different fact, not a smaller
  // version of the same one: accounts that exist, said as accounts.
  if (members !== null && members > 0) return { scope: 'members', count: members };
  return { scope: 'none' };
}
