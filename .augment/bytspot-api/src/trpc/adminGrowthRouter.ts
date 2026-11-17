import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { assertBytspotAdmin, auditAdminAction } from '../services/adminRbac';
import { loadGrowthReport } from '../services/growth';

export const adminGrowthRouter = router({
  /** Weekly use, invites and coming-back figures for the admin Growth tab. */
  report: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'admin-growth-report' }))
    .query(async ({ ctx }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.growth.report' });
      return loadGrowthReport();
    }),
});
