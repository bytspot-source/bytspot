import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import {
  globalBudgetMiddleware, incrementLocalRateLimit, incrementRedisRateLimit, peekLocalRateLimit, rateLimitMiddleware, rateLimitSubject, protectedProcedure,
} from '../trpc/trpc';

/**
 * REA review 2026-11-10 (C1, C3). Who may reach an LLM-backed concierge
 * route, and how often.
 *  - Pilot: CONCIERGE_AUDIENCE=pilot (default) admits only CONCIERGE_PILOT_USER_IDS.
 *  - Everyone else needs a confirmed email once the audience is opened.
 *  - CONCIERGE_REQUIRE_AI_CONSENT=true refuses members who have not agreed to
 *    the OpenAI disclosure (consent.setAiConsent).
 *  - CONCIERGE_DAILY_QUOTA per member per day, CONCIERGE_GLOBAL_DAILY_MAX for everyone.
 */
export function onConciergePilot(userId: string | undefined): boolean {
  if (config.conciergeAudience === 'everyone') return true;
  const id = userId?.trim();
  return !!id && config.conciergePilotUserIds.split(',').some((entry) => entry.trim() === id);
}

export type ConciergeRefusal = 'not-enabled' | 'confirm-email' | 'ai-consent';

export async function conciergeRefusal(userId: string): Promise<ConciergeRefusal | null> {
  if (!onConciergePilot(userId)) return 'not-enabled';
  if (config.conciergeAudience !== 'everyone' && !config.conciergeRequireAiConsent) return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true, aiConsentAt: true } });
  if (config.conciergeAudience === 'everyone' && !user?.emailVerifiedAt) return 'confirm-email';
  if (config.conciergeRequireAiConsent && !user?.aiConsentAt) return 'ai-consent';
  return null;
}

export const CONCIERGE_REFUSAL_TEXT: Record<ConciergeRefusal, string> = {
  'not-enabled': 'Concierge is not enabled for your account yet. You can browse places in Discover.',
  'confirm-email': 'Confirm your email to use Concierge.',
  'ai-consent': 'Concierge sends your request to OpenAI to plan it. Agree to that in Settings to use Concierge.',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One step of the shared Concierge counters. `failClosed` matches the global
 * breaker: a Redis miss in production refuses, instead of counting per process.
 * A non-positive max is unlimited, same as globalBudgetMiddleware.
 */
async function consumeConciergeCounter(key: string, max: number, failClosed: boolean): Promise<boolean> {
  if (max <= 0) return true;
  let count: number | null = null;
  const redis = getRedis();
  if (redis) {
    try {
      count = await incrementRedisRateLimit(redis, `rate-limit:${key}`, DAY_MS);
    } catch {
      if (failClosed) return false;
      count = null;
    }
  }
  if (count === null) {
    if (failClosed && config.nodeEnv === 'production') return false;
    count = incrementLocalRateLimit(key, DAY_MS);
  }
  return count !== null && count <= max;
}

/** Model-written suggestion lists per guest per day. Separate from the guest's Concierge turns. */
export const CONCIERGE_SUGGESTIONS_DAILY_MAX = 10;

/** Whether the guest still has Concierge turns today, without spending one. */
export async function conciergeTurnsLeft(userId: string): Promise<boolean> {
  if (config.conciergeDailyQuota <= 0) return true;
  const key = `concierge-daily:${rateLimitSubject(userId, '')}`;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(`rate-limit:${key}`);
      return Number(raw ?? 0) < config.conciergeDailyQuota;
    } catch { /* fall back to the local count */ }
  }
  return peekLocalRateLimit(key) < config.conciergeDailyQuota;
}

/**
 * Reserve one model call for opening suggestions. It never spends the guest's
 * Concierge turns: it uses its own small daily allowance, and the shared global
 * breaker so total model spend stays capped. False means use the curated list.
 */
export async function reserveConciergeSuggestionTurn(userId: string): Promise<boolean> {
  const ownOk = await consumeConciergeCounter(
    `concierge-suggestions-daily:${rateLimitSubject(userId, '')}`, CONCIERGE_SUGGESTIONS_DAILY_MAX, false,
  );
  if (!ownOk) return false;
  return consumeConciergeCounter('budget:concierge-global-daily', config.conciergeGlobalDailyMax, true);
}

/**
 * Reserve one model turn against the same daily and global counters as
 * concierge.plan and concierge.chat. False means the turn is spent or the
 * breaker is closed: the caller must not call the model.
 */
export async function reserveConciergeModelTurn(userId: string): Promise<boolean> {
  const dailyOk = await consumeConciergeCounter(
    `concierge-daily:${rateLimitSubject(userId, '')}`, config.conciergeDailyQuota, false,
  );
  if (!dailyOk) return false;
  return consumeConciergeCounter('budget:concierge-global-daily', config.conciergeGlobalDailyMax, true);
}

/** The quota and breaker every LLM-backed concierge procedure shares. */
export const conciergeProcedure = (label: string, perMinute: number) => protectedProcedure
  .use(rateLimitMiddleware({ windowMs: 60_000, max: perMinute, label }))
  .use(rateLimitMiddleware({ windowMs: DAY_MS, max: config.conciergeDailyQuota, label: 'concierge-daily' }))
  .use(globalBudgetMiddleware({
    windowMs: DAY_MS, max: () => config.conciergeGlobalDailyMax, label: 'concierge-global-daily',
    message: 'Concierge is very busy today. Try again tomorrow.',
  }));

export function throwConciergeRefusal(refusal: ConciergeRefusal): never {
  throw new TRPCError({ code: refusal === 'not-enabled' ? 'FORBIDDEN' : 'PRECONDITION_FAILED', message: CONCIERGE_REFUSAL_TEXT[refusal] });
}
