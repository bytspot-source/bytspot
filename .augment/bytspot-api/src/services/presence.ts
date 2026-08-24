import { getRedis } from '../lib/redis';
import { db } from '../lib/db';

/** Sliding window for "active". A day, not an evening: lunch, a coffee and an
 *  afternoon are uses of a city too, and an hourly window quietly encoded the
 *  assumption that only nightlife counts. Stated in the UI copy — a count
 *  without a declared window is unfalsifiable. */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Below this, an area count is noise dressed as density and is not rendered. */
export const GLOBAL_FLOOR = 15;

/** One write per user per minute is enough resolution for a daily window. */
const WRITE_THROTTLE_MS = 60 * 1000;

/** Roughly neighbourhood scale: small enough that "here" is true, large enough
 *  that a corridor is one room rather than forty. */
const CELL_DEGREES = 0.02;

const lastWrite = new Map<string, number>();

/** A coarse grid cell, derived on the server so the client cannot name its own
 *  room. Coordinates are used to pick the cell and are never stored. */
export function cellFor(lat: number, lng: number): string {
  const quantise = (value: number) => Math.floor(value / CELL_DEGREES) * CELL_DEGREES;
  return `${quantise(lat).toFixed(2)}:${quantise(lng).toFixed(2)}`;
}

/** Cells we have a catalog for, and may therefore name. Anywhere else is real
 *  but unnamed: we know someone is in a cell, not that they are in a place we
 *  have mapped. */
const NAMED_CELLS: Record<string, string> = {
  [cellFor(33.7838, -84.383)]: 'Midtown',
};

export function cellName(cell: string | null): string | null {
  return cell ? NAMED_CELLS[cell] ?? null : null;
}

const activeKey = (cell: string) => `presence:active:${cell}`;

/** Record a user as active in a cell. Never throws: presence is decoration on
 *  a request that has already done its real work. */
export async function recordActive(userId: string, cell: string | null, now = Date.now()): Promise<void> {
  if (!cell) return;
  const throttleKey = `${userId}:${cell}`;
  const previous = lastWrite.get(throttleKey);
  if (previous && now - previous < WRITE_THROTTLE_MS) return;
  lastWrite.set(throttleKey, now);

  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.zadd(activeKey(cell), now, userId);
    await redis.zremrangebyscore(activeKey(cell), 0, now - ACTIVE_WINDOW_MS);
  } catch {
    // Redis unavailability must never surface as a failed request.
  }
}

/** Distinct users active in one cell inside the window, or null when
 *  unknowable. Null and zero are different answers and must stay
 *  distinguishable. */
export async function activeCount(cell: string | null, now = Date.now()): Promise<number | null> {
  if (!cell) return null;
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.zcount(activeKey(cell), now - ACTIVE_WINDOW_MS, now);
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
  | { scope: 'area'; count: number; area: string | null }
  | { scope: 'members'; count: number }
  | { scope: 'none' };

/** The home count is the area, not the world and not the people a member
 *  knows. An area count is the only one a member can act on, and it is the
 *  same number at any size — a city of millions still answers "is anyone
 *  here" one cell at a time. */
export function resolveSummary(
  area: number | null,
  members: number | null = null,
  cell: string | null = null,
): PresenceSummary {
  if (area !== null && area >= GLOBAL_FLOOR) return { scope: 'area', count: area, area: cellName(cell) };
  // Below the floor the honest fallback is a different fact, not a smaller
  // version of the same one: accounts that exist, said as accounts.
  if (members !== null && members > 0) return { scope: 'members', count: members };
  return { scope: 'none' };
}
