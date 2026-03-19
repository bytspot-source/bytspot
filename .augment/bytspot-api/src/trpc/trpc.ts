import { initTRPC, TRPCError } from '@trpc/server';
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
 * Simple in-memory rate limiter for tRPC procedures.
 * Uses a sliding-window counter per key (userId or 'anon').
 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(opts: { windowMs: number; max: number; label: string }) {
  return t.middleware(async ({ ctx, next }) => {
    const key = `${opts.label}:${ctx.user?.userId ?? 'anon'}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (bucket && bucket.resetAt > now) {
      if (bucket.count >= opts.max) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Rate limit exceeded for ${opts.label}. Try again later.`,
        });
      }
      bucket.count++;
    } else {
      rateBuckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    }

    return next();
  });
}

