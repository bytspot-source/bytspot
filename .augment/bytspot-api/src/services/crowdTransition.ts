import { getRedis } from '../lib/redis';

/** True only for a real transition into the Packed alert threshold. */
export function entersPacked(previousLevel: number | null | undefined, nextLevel: number): boolean {
  return (previousLevel ?? 0) < 4 && nextLevel >= 4;
}

/** A venue that flaps in and out of Packed must not notify every member each
 *  time, and the serialized read only protects one process. Sliding from the
 *  alert rather than aligned to the clock: an hour bucket would let 21:58 and
 *  22:05 both fire while suppressing a genuine re-pack 50 minutes later.
 *
 *  Fails open. Redis is optional here, and no Redis must mean alerts still
 *  send rather than silently stop. */
export async function claimPackedAlert(venueId: string, ttlSeconds = 3600, redis = getRedis()): Promise<boolean> {
  if (!redis) return true;
  try {
    return (await redis.set(`alert:packed:${venueId}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  } catch {
    return true;
  }
}
