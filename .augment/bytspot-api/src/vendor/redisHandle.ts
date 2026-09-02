import { getRedis } from '../lib/redis';

/** Only the commands the vendor auth store uses, so a test can supply a fake. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/**
 * Indirection so tests can substitute a store, in the same style as the Prisma
 * stubs elsewhere in this suite: reassign a property on an exported object.
 */
export const redisHandle = {
  get: (): RedisLike | null => getRedis() as RedisLike | null,
};

/**
 * Redis is required for vendor auth, not optional.
 *
 * The cache falls back to null when REDIS_URL is unset, which is right for a
 * cache and wrong for this: an auth store in process memory resets every
 * challenge on deploy, and worse, lets each instance disagree about how many
 * attempts a code has had — so three guesses becomes three per instance.
 * Sign-in fails closed instead.
 */
export function requireRedis(): RedisLike {
  const redis = redisHandle.get();
  if (!redis) {
    throw new Error('REDIS_URL is required for vendor sign-in; refusing to hold credentials in memory');
  }
  return redis;
}
