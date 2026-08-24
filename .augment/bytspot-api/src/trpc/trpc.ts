import { initTRPC, TRPCError } from '@trpc/server';
import type Redis from 'ioredis';
import { getRedis } from '../lib/redis';
import { isSessionRevoked } from '../services/accountDeletion';
import type { Context } from './context';

/**
 * tRPC initialisation — single instance, shared across all routers.
 */
const t = initTRPC.context<Context>().create();

/** Base router factory */
export const router = t.router;

/** Caller factory — used by integration tests to invoke procedures directly */
export const createCallerFactory = t.createCallerFactory;

/** Public procedure — no auth required */
export const publicProcedure = t.procedure;

/**
 * Authenticated procedure — requires a valid JWT.
 * Narrows context.user from `AuthPayload | null` to `AuthPayload`.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }
  // Access tokens outlive a deletion request, so a pending-deletion account
  // must lose its live sessions rather than stay usable until the JWT expires.
  if (await isSessionRevoked(ctx.user.userId)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This account is pending deletion' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Fixed-window rate limiter for tRPC procedures. Redis counters provide a
 * shared production limit; the bounded in-memory map is a failure fallback.
 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const MAX_LOCAL_RATE_BUCKETS = 10_000;
const REDIS_FIXED_WINDOW_INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// Cleanup stale buckets every 5 minutes to prevent unbounded memory growth
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) {
      rateBuckets.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[rate-limit] Cleaned ${cleaned} stale bucket(s), ${rateBuckets.size} active`);
  }
}, CLEANUP_INTERVAL_MS).unref(); // .unref() so this timer doesn't prevent graceful shutdown

export function rateLimitSubject(userId: string | undefined, clientKey: string): string {
  // Public procedures are keyed to a hashed, proxy-aware client IP; protected
  // procedures retain a stable per-user key. Never use a shared `anon` bucket.
  return userId ? `user:${userId}` : `client:${clientKey}`;
}

export async function incrementRedisRateLimit(
  redis: Pick<Redis, 'eval'>,
  key: string,
  windowMs: number,
): Promise<number> {
  const count = await redis.eval(REDIS_FIXED_WINDOW_INCREMENT, 1, key, String(windowMs));
  if (typeof count !== 'number') throw new Error('Invalid Redis rate-limit response');
  return count;
}

export function incrementLocalRateLimit(key: string, windowMs: number, now = Date.now()): number | null {
  const bucket = rateBuckets.get(key);
  if (bucket && bucket.resetAt > now) {
    bucket.count++;
    return bucket.count;
  }
  if (rateBuckets.size >= MAX_LOCAL_RATE_BUCKETS) return null;
  rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
  return 1;
}

/** Test-only reset; no production call sites. */
export function resetLocalRateLimitForTests(): void {
  rateBuckets.clear();
}

/** Marks a middleware as a limiter so the router can be audited for coverage. */
export const RATE_LIMIT_LABEL = Symbol.for('bytspot.rateLimitLabel');

export function rateLimitMiddleware(opts: { windowMs: number; max: number; label: string }) {
  const limiter: Parameters<typeof t.middleware>[0] = async ({ ctx, next }) => {
    const key = `${opts.label}:${rateLimitSubject(ctx.user?.userId, ctx.clientRateLimitKey)}`;
    let count: number | null = null;
    const redis = getRedis();
    if (redis) {
      try {
        count = await incrementRedisRateLimit(redis, `rate-limit:${key}`, opts.windowMs);
      } catch {
        // Redis unavailability must not take down the API; use bounded local fallback.
        count = null;
      }
    }

    if (count === null) count = incrementLocalRateLimit(key, opts.windowMs);

    // A full local fallback is deliberately fail-closed to cap memory pressure
    // during a Redis outage and high-cardinality abuse.
    if (count === null || count > opts.max) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded for ${opts.label}. Try again later.`,
      });
    }
    return next();
  };
  // The label rides on the function itself: tRPC keeps the raw middleware, so
  // this is what a router-wide audit can see.
  return t.middleware(Object.assign(limiter, { [RATE_LIMIT_LABEL]: opts.label }));
}

