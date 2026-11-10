import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../lib/db';
import { globalBudgetMiddleware, rateLimitMiddleware, protectedProcedure } from '../trpc/trpc';

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
