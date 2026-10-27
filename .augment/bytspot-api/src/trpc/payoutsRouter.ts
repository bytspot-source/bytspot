import { TRPCError } from '@trpc/server';
import { hostDashboardLink, hostOnboardingLink, refreshHostPayout } from '../services/hostPayouts';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const unavailable = () => new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payouts are not available right now.' });

/**
 * A host's payout account. Stripe hosts every form: these calls only mint
 * links into it and read back what Stripe decided.
 */
const hostPayoutsRouter = router({
  status: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'host-payout-status' }))
    .query(({ ctx }) => refreshHostPayout(ctx.user.userId)),

  onboardingLink: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'host-payout-onboarding' }))
    .mutation(async ({ ctx }) => {
      const link = await hostOnboardingLink(ctx.user.userId);
      if (!link) throw unavailable();
      return link;
    }),

  dashboardLink: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'host-payout-dashboard' }))
    .mutation(async ({ ctx }) => {
      const link = await hostDashboardLink(ctx.user.userId);
      if (!link) throw new TRPCError({ code: 'NOT_FOUND', message: 'Set up payouts first.' });
      return link;
    }),
});

export const payoutsRouter = router({ host: hostPayoutsRouter });
