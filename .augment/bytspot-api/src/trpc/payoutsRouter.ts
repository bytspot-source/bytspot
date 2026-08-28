import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  currentHostPayoutReadiness,
  ensureHostAccount,
  hostOnboardingLink,
  PAYOUT_DELAY_DAYS,
  refreshHostAccount,
} from '../services/hostPayouts';
import { config } from '../config';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

/**
 * Host payouts. Onboarding, identity and bank details all live in Stripe
 * Express, so this surface only starts the hosted flow and reports Stripe's
 * verdict. Bytspot never sees a bank number.
 */
export const hostPayoutsRouter = router({
  /** The host's own payout state, refreshed from Stripe when not yet ready. */
  status: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'host-payouts-status' }))
    .query(async ({ ctx }) => {
      const readiness = await currentHostPayoutReadiness(ctx.user.userId);
      return {
        connected: Boolean(readiness.accountId),
        chargesEnabled: readiness.chargesEnabled,
        payoutsEnabled: readiness.payoutsEnabled,
        ready: readiness.ready,
        payoutDelayDays: PAYOUT_DELAY_DAYS,
      };
    }),

  /**
   * Start or resume Stripe's hosted onboarding. Resuming is the same call: an
   * account link is short-lived, so a host who abandons the flow needs a fresh
   * one rather than a second account.
   */
  startOnboarding: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'host-payouts-onboarding' }))
    .input(z.object({ returnPath: z.string().trim().max(200).regex(/^\/[A-Za-z0-9\-/_]*$/).default('/host/payouts') }))
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payouts are not available yet.' });
      const accountId = await ensureHostAccount(ctx.user.userId, ctx.user.email);
      const url = await hostOnboardingLink(accountId, input.returnPath);
      return { url };
    }),

  /** Pull Stripe's verdict now — used when a host returns from onboarding. */
  refresh: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'host-payouts-refresh' }))
    .mutation(async ({ ctx }) => {
      const readiness = await currentHostPayoutReadiness(ctx.user.userId);
      if (!readiness.accountId) return { ...readiness, connected: false, payoutDelayDays: PAYOUT_DELAY_DAYS };
      const fresh = await refreshHostAccount(ctx.user.userId, readiness.accountId);
      return { ...fresh, connected: true, payoutDelayDays: PAYOUT_DELAY_DAYS };
    }),
});
