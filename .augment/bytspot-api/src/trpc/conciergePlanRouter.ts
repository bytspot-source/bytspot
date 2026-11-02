import { z } from 'zod';
import { createBackendEngine } from '../bytt-si/backend';
import type { ConciergeRequest, ConciergeResult } from '../bytt-si/types';
import { conciergeResultSchema } from '../bytt-si/types';
import { config } from '../config';
import { coordinateSchema } from '../services/conciergeDiscovery';
import type { Context } from './context';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

/** concierge.plan is open to every signed-in user when CONCIERGE_PLAN_ENABLED is on. */
export function conciergePlanOpenTo(): boolean {
  return config.conciergePlanEnabled;
}

export const conciergePlanInput = z.object({
  message: z.string().max(2000).trim().min(1),
  location: coordinateSchema.optional(),
}).strict();

export const conciergePlanOutput = z.object({
  version: z.literal(1),
  status: z.enum(['ok', 'unavailable']),
  /** Server-written text for the unavailable states; null when `result` carries the answer. */
  reply: z.string().nullable(),
  result: conciergeResultSchema.nullable(),
}).strict();

export interface ConciergePlanDependencies {
  /** Null when the engine cannot run (no model key): the route says so instead of guessing. */
  engineFor(ctx: Context): { handle(request: ConciergeRequest): Promise<ConciergeResult> } | null;
  now?: () => Date;
  /** Hard limit for one request; past it the route answers unavailable. */
  timeoutMs?: number;
}

/** Above the engine's own time budget plus one in-flight model call. */
export const CONCIERGE_PLAN_TIMEOUT_MS = 50_000;

const NOT_ENABLED = 'Concierge plans are not enabled yet. You can browse places in Discover.';
const UNAVAILABLE = 'Concierge plans are unavailable right now. Nothing was made up.';
const TIMED_OUT = 'That took too long to plan. Try again, or ask for fewer stops. Nothing was made up.';

const TIMEOUT = Symbol('timeout');

/**
 * BYTT-SI: one request in, a proposed Plan (or a quick answer with "Make it a
 * plan") out. Read-only: nothing is saved or booked here. Saving goes through
 * plans.create / plans.createWithBookables, and plans.feasibility
 * (planFeasibility) stays the final word on a saved Plan — the same check this
 * route already applies to the proposal before it offers booking.
 */
export function createConciergePlanRouter(deps: ConciergePlanDependencies) {
  return router({
    plan: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'concierge-plan' }))
      .input(conciergePlanInput)
      .output(conciergePlanOutput)
      .mutation(async ({ ctx, input }) => {
        if (!conciergePlanOpenTo()) return { version: 1 as const, status: 'unavailable' as const, reply: NOT_ENABLED, result: null };
        const engine = deps.engineFor(ctx);
        if (!engine) return { version: 1 as const, status: 'unavailable' as const, reply: UNAVAILABLE, result: null };
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          engine.handle({
            message: input.message,
            now: (deps.now?.() ?? new Date()).toISOString(),
            userId: ctx.user.userId,
            ...(input.location ? { latitude: input.location.lat, longitude: input.location.lng } : {}),
          }),
          new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), deps.timeoutMs ?? CONCIERGE_PLAN_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        if (result === TIMEOUT) return { version: 1 as const, status: 'unavailable' as const, reply: TIMED_OUT, result: null };
        return { version: 1 as const, status: 'ok' as const, reply: null, result };
      }),
  });
}

export const conciergePlanRouter = createConciergePlanRouter({ engineFor: createBackendEngine });
