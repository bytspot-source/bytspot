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

/** People in the caller's circles holding a confirmed pass for a party that is
 *  running now. Evidenced, not inferred: a granted PartyGuest row is a fact. */
export async function circleOutCount(userId: string, now = new Date()): Promise<number> {
  const memberships = await db.socialCircleMember.findMany({
    where: { userId },
    select: { circleId: true },
  });
  if (memberships.length === 0) return 0;

  const peers = await db.socialCircleMember.findMany({
    where: { circleId: { in: memberships.map((m) => m.circleId) }, userId: { not: userId } },
    select: { userId: true },
    distinct: ['userId'],
  });
  if (peers.length === 0) return 0;

  const out = await db.partyGuest.findMany({
    where: {
      userId: { in: peers.map((p) => p.userId) },
      accessGranted: true,
      party: {
        status: 'published',
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return out.length;
}

export type PresenceSummary =
  | { scope: 'circle'; count: number }
  | { scope: 'global'; count: number }
  | { scope: 'none' };

/** Circle wins whenever it has something to say: "3 people you know are out"
 *  is both Evidenced and stronger than a crowd of strangers. */
export function resolveSummary(circle: number, global: number | null): PresenceSummary {
  if (circle > 0) return { scope: 'circle', count: circle };
  if (global !== null && global >= GLOBAL_FLOOR) return { scope: 'global', count: global };
  return { scope: 'none' };
}
