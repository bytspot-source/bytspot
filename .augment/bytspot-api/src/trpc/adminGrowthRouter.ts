import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { assertBytspotAdmin, auditAdminAction } from '../services/adminRbac';
import { z } from 'zod';
import { GROWTH_RANGES, loadGrowthReport } from '../services/growth';

export const adminGrowthRouter = router({
  /** Weekly use, invites and coming-back figures for the admin Growth tab. */
  report: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'admin-growth-report' }))
    .input(z.object({ range: z.enum(GROWTH_RANGES).default('8w') }).optional())
    .query(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const range = input?.range ?? '8w';
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.growth.report', detail: { range } });
      return loadGrowthReport(new Date(), range);
    }),
});
