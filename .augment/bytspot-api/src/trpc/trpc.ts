import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';

/**
 * tRPC initialisation — single instance, shared across all routers.
 */
const t = initTRPC.context<Context>().create();

/** Base router factory */
export const router = t.router;

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

