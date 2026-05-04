import { initTRPC, TRPCError } from '@trpc/server';
import type { Entity, Prisma } from '@prisma/client';
import type { Context } from './context';
import { db } from '../lib/db';

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
 * Uses a fixed-window counter per key (userId or 'anon').
 * Includes periodic cleanup to prevent memory leaks from stale buckets.
 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

type RateLimitOptions = { windowMs: number; max: number; label: string };

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

export function enforceRateLimit(opts: RateLimitOptions, key: string): void {
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
    return;
  }

  rateBuckets.set(key, { count: 1, resetAt: now + opts.windowMs });
}

export function resetRateLimitBucketsForTests(): void {
  if (process.env.NODE_ENV === 'test') {
    rateBuckets.clear();
  }
}

export function rateLimitMiddleware(opts: RateLimitOptions) {
  return t.middleware(async ({ ctx, next }) => {
    const key = `${opts.label}:${ctx.user?.userId ?? 'anon'}`;
    enforceRateLimit(opts, key);

    return next();
  });
}

type SovereignShieldResolverArgs = {
  ctx: Context;
  path: string;
};

type SovereignShieldOutcome = 'allow' | 'deny' | 'flag';

type MaybeResolver<T> = T | ((args: SovereignShieldResolverArgs) => T);

export interface SovereignShieldOptions {
  entity?: Entity;
  frameworks?: MaybeResolver<readonly string[]>;
  policyContext?: MaybeResolver<Prisma.InputJsonValue | undefined>;
  stateFlags?: MaybeResolver<readonly string[]>;
}

function resolveValue<T>(
  value: MaybeResolver<T> | undefined,
  args: SovereignShieldResolverArgs,
  fallback: T,
): T {
  if (typeof value === 'function') {
    return (value as (args: SovereignShieldResolverArgs) => T)(args);
  }
  return value ?? fallback;
}

function normalizeList(value: readonly string[]): string[] {
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)));
}

function getRequestIp(req: Context['req']): string | undefined {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(',')[0]?.trim();
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0]?.trim();
  return req?.ip || undefined;
}

function getErrorReason(error: unknown): string | undefined {
  if (error instanceof TRPCError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return undefined;
}

function setSovereignShieldHeaders(
  ctx: Context,
  payload: {
    entity: Entity;
    outcome: SovereignShieldOutcome;
    frameworks: string[];
    stateFlags: string[];
  },
): void {
  if (!ctx.res) return;

  ctx.res.setHeader('X-Sovereign-Shield', 'active');
  ctx.res.setHeader('X-Sovereign-Entity', payload.entity);
  ctx.res.setHeader('X-Sovereign-Outcome', payload.outcome);
  if (payload.frameworks.length > 0) {
    ctx.res.setHeader('X-Sovereign-Frameworks', payload.frameworks.join(','));
  }
  if (payload.stateFlags.length > 0) {
    ctx.res.setHeader('X-Sovereign-State-Flags', payload.stateFlags.join(','));
  }
}

async function writeComplianceLog(entry: {
  ctx: Context;
  path: string;
  entity: Entity;
  frameworks: string[];
  policyContext?: Prisma.InputJsonValue;
  stateFlags: string[];
  outcome: SovereignShieldOutcome;
  reason?: string;
}): Promise<void> {
  try {
    await db.complianceLog.create({
      data: {
        userId: entry.ctx.user?.userId ?? null,
        entity: entry.entity,
        procedure: entry.path,
        frameworks: entry.frameworks,
        policyContext: entry.policyContext,
        stateFlags: entry.stateFlags,
        outcome: entry.outcome,
        reason: entry.reason,
        requestIp: getRequestIp(entry.ctx.req) ?? null,
      },
    });
  } catch (error) {
    console.error('[sovereign-shield] failed to write compliance log', error);
  }
}

/**
 * Sovereign Shield middleware — attaches lightweight compliance headers and
 * records an immutable-ish audit row for the procedure invocation.
 */
export function sovereignShieldMiddleware(opts: SovereignShieldOptions = {}) {
  return t.middleware(async ({ ctx, path, next }) => {
    const args: SovereignShieldResolverArgs = { ctx, path };
    const entity = (opts.entity ?? 'BYTSPOT_INC') as Entity;
    const frameworks = normalizeList(resolveValue(opts.frameworks, args, []));
    const stateFlags = normalizeList(resolveValue(opts.stateFlags, args, []));
    const policyContext = resolveValue(opts.policyContext, args, undefined);

    try {
      const result = await next();
      const outcome: SovereignShieldOutcome = result.ok ? 'allow' : 'deny';
      const reason = result.ok ? undefined : getErrorReason(result.error);
      setSovereignShieldHeaders(ctx, {
        entity,
        outcome,
        frameworks,
        stateFlags,
      });
      await writeComplianceLog({
        ctx,
        path,
        entity,
        frameworks,
        policyContext,
        stateFlags,
        outcome,
        reason,
      });
      return result;
    } catch (error) {
      setSovereignShieldHeaders(ctx, {
        entity,
        outcome: 'deny',
        frameworks,
        stateFlags,
      });
      await writeComplianceLog({
        ctx,
        path,
        entity,
        frameworks,
        policyContext,
        stateFlags,
        outcome: 'deny',
        reason: getErrorReason(error),
      });
      throw error;
    }
  });
}

