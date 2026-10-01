/**
 * Admin Vendors: every business in the vendor console, and the approval that
 * lets a finished one go live. Approval is recorded once; the lifecycle still
 * moves only through advanceSeller, so an early approval takes effect the
 * moment the business finishes setting up.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { config } from '../config';
import { sendVendorVerifiedEmail } from '../lib/email';
import { assertBytspotAdmin, auditAdminAction } from '../services/adminRbac';
import { advanceSeller, awaitingApproval, markVerified, outstandingRequirements, satisfiedRequirements } from '../vendor/sellerState';
import { requirementsForState } from '../vendor/contract';

/** Where the verified email links: the vendor console's own origin. */
export function vendorConsoleOrigin(origins: string[] = config.corsOrigins): string {
  return origins.find((origin) => /^https:\/\/vendor\./.test(origin)) ?? 'https://vendor.bytspot.app';
}

export const adminVendorsRouter = router({
  /** Businesses waiting on approval first, then the rest, newest first. */
  list: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-vendors-list' }))
    .query(async ({ ctx }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.vendors.list' });
      const sellers = await db.vendorSeller.findMany({
        where: { state: { not: 'CLOSED' } },
        include: { locations: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const live = new Set(requirementsForState('ACTIVE'));
      const rows = sellers.map((seller) => {
        const satisfied = satisfiedRequirements(seller, seller.locations);
        return {
          sellerId: seller.id,
          legalName: seller.legalName?.trim() || 'Unnamed business',
          contactEmail: seller.contactEmail,
          businessKind: seller.businessKind,
          state: seller.state,
          awaitingApproval: awaitingApproval(seller, seller.locations),
          approvedAt: seller.approvedAt,
          verifiedAt: seller.verifiedAt,
          createdAt: seller.createdAt,
          locations: seller.locations.filter((l) => l.state !== 'CLOSED').map((l) => ({ label: l.label, address: l.address, state: l.state })),
          missing: [...live].filter((id) => !satisfied.includes(id)),
          outstanding: outstandingRequirements(seller, seller.locations),
        };
      });
      rows.sort((a, b) => Number(b.awaitingApproval) - Number(a.awaitingApproval));
      return { sellers: rows, awaiting: rows.filter((r) => r.awaitingApproval).length };
    }),

  /** Approves a business. It goes live now if it is finished, or when it finishes. */
  approve: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-vendors-approve' }))
    .input(z.object({ sellerId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const seller = await db.vendorSeller.findUnique({ where: { id: input.sellerId }, include: { locations: true } });
      if (!seller || seller.state === 'CLOSED') throw new TRPCError({ code: 'NOT_FOUND', message: 'No such business.' });

      // Conditional, so two admins approving at once record one approver.
      await db.vendorSeller.updateMany({
        where: { id: seller.id, approvedAt: null },
        data: { approvedAt: new Date(), approvedByUserId: ctx.user.userId },
      });
      const approved = await db.vendorSeller.findUniqueOrThrow({ where: { id: seller.id } });
      const moved = await advanceSeller(approved, seller.locations);
      const verified = await markVerified(moved);
      if (verified.first && moved.contactEmail) {
        void sendVendorVerifiedEmail(moved.contactEmail, {
          legalName: moved.legalName ?? 'Your business',
          consoleUrl: vendorConsoleOrigin(),
        });
      }
      auditAdminAction({
        actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.vendors.approve',
        detail: { sellerId: seller.id, state: verified.seller.state },
      });
      return { state: verified.seller.state, live: verified.seller.state === 'ACTIVE' };
    }),
});
