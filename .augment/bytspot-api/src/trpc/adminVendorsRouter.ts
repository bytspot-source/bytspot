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
import { mediaUrl } from '../vendor/media';

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
          videoHostingAt: seller.videoHostingAt,
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

  /** Vendor photos, menus and videos waiting for the team, oldest first. */
  mediaQueue: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-vendors-media-queue' }))
    .query(async ({ ctx }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.vendors.mediaQueue' });
      const rows = await db.vendorMedia.findMany({
        where: { reviewStatus: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: {
          id: true, kind: true, mimeType: true, byteSize: true, createdAt: true,
          seller: { select: { id: true, legalName: true, videoHostingAt: true } },
          location: { select: { label: true } },
          bookable: { select: { skuTemplateId: true, location: { select: { label: true } } } },
        },
      });
      return {
        media: rows.map((row) => ({
          mediaId: row.id, kind: row.kind, mimeType: row.mimeType, byteSize: row.byteSize, createdAt: row.createdAt,
          url: mediaUrl(row.id),
          sellerId: row.seller.id, business: row.seller.legalName?.trim() || 'Unnamed business',
          place: row.location?.label ?? row.bookable?.location.label ?? null,
          offering: row.bookable?.skuTemplateId ?? null,
          videoHosting: Boolean(row.seller.videoHostingAt),
        })),
      };
    }),

  /** Approves a vendor file so guests see it, or rejects it with a note the vendor reads. */
  reviewMedia: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 120, label: 'admin-vendors-review-media' }))
    .input(z.object({
      mediaId: z.string().min(1).max(64),
      approve: z.boolean(),
      note: z.string().trim().max(280).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const reviewStatus = input.approve ? 'approved' : 'rejected';
      const updated = await db.vendorMedia.updateMany({
        where: { id: input.mediaId },
        data: { reviewStatus, reviewedAt: new Date(), reviewedByUserId: ctx.user.userId, reviewNote: input.approve ? null : input.note || null },
      });
      if (updated.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'That file no longer exists.' });
      auditAdminAction({
        actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.vendors.reviewMedia',
        detail: { mediaId: input.mediaId, reviewStatus },
      });
      return { reviewStatus };
    }),

  /**
   * Paid video hosting. On: the business can upload a video and guests see
   * it once approved. Off: uploads stop and guests stop seeing video; the
   * stored clip is kept so switching back on restores it.
   */
  setVideoHosting: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-vendors-video-hosting' }))
    .input(z.object({ sellerId: z.string().min(1).max(64), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const seller = await db.vendorSeller.findUnique({ where: { id: input.sellerId }, select: { id: true } });
      if (!seller) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such business.' });
      await db.vendorSeller.update({
        where: { id: seller.id },
        data: input.enabled
          ? { videoHostingAt: new Date(), videoHostingByUserId: ctx.user.userId }
          : { videoHostingAt: null, videoHostingByUserId: null },
      });
      auditAdminAction({
        actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.vendors.setVideoHosting',
        detail: { sellerId: seller.id, enabled: input.enabled },
      });
      return { enabled: input.enabled };
    }),
});
