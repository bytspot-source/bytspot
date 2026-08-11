import { initTRPC, TRPCError } from '@trpc/server';
import { getRedis } from '../lib/redis';
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
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Fixed-window rate limiter for tRPC procedures. Redis counters provide a
 * shared production limit; the bounded in-memory map is a failure fallback.
 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

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

export function rateLimitMiddleware(opts: { windowMs: number; max: number; label: string }) {
  return t.middleware(async ({ ctx, next }) => {
    const key = `${opts.label}:${rateLimitSubject(ctx.user?.userId, ctx.clientRateLimitKey)}`;
    let count: number | null = null;
    const redis = getRedis();
    if (redis) {
      try {
        count = await redis.incr(`rate-limit:${key}`);
        if (count === 1) await redis.pexpire(`rate-limit:${key}`, opts.windowMs);
      } catch {
        // Redis unavailability must not take down the API; use local fallback.
        count = null;
      }
    }

    if (count === null) {
      const now = Date.now();
      const bucket = rateBuckets.get(key);
      if (bucket && bucket.resetAt > now) {
        bucket.count++;
        count = bucket.count;
      } else {
        rateBuckets.set(key, { count: 1, resetAt: now + opts.windowMs });
        count = 1;
      }
    }

    if (count > opts.max) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded for ${opts.label}. Try again later.`,
      });
    }
    return next();
  });
}

