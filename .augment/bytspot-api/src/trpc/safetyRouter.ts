import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { config } from '../config';
import { sendSafetyReportAlert } from '../lib/email';
import { captureError } from '../lib/observability';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';
import {
  AUTO_HIDE_REPORTERS,
  MAX_BLOCKS,
  REPORT_KINDS,
  REPORT_REASONS,
  blockMember,
  openVerifiedReporters,
  reportTarget,
  setModerationHidden,
  type ReportKind,
  type ReportTarget,
} from '../services/safety';

const DAY_MS = 24 * 60 * 60 * 1000;
const unavailable = () => new TRPCError({ code: 'NOT_FOUND', message: "That isn't available." });
const memberId = z.string().min(1).max(128);

function alertSummary(kind: ReportKind, target: ReportTarget): string {
  const s = target.snapshot as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
  switch (kind) {
    case 'user': return `Member: ${text(s.name) || 'no name'}`;
    case 'party': return `Party: ${text(s.title)}`;
    case 'review': return `Review of ${text(s.venueName)}: ${text(s.comment) || `${String(s.stars)} stars`}`;
    case 'sale': return `Private Sale: ${text(s.title)}`;
  }
}

/**
 * Report and block, for members. Neither tells the other member anything: a
 * report never names its reporter, and a blocked member reads the blocker's
 * things as no longer there.
 */
export const safetyRouter = router({
  /**
   * One report per member per item; a repeat is accepted and not counted again.
   * The item is hidden from everyone once enough members with confirmed emails
   * report it, so one member alone can't take something down.
   */
  report: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: DAY_MS, max: 20, label: 'safety-report' }))
    .input(z.object({
      kind: z.enum(REPORT_KINDS),
      targetId: z.string().min(1).max(128),
      reason: z.enum(REPORT_REASONS),
      note: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const target = await reportTarget(input.kind, input.targetId);
      if (!target) throw unavailable();
      if (target.ownerId === ctx.user.userId) throw new TRPCError({ code: 'BAD_REQUEST', message: "You can't report yourself." });

      try {
        await db.contentReport.create({
          data: {
            reporterId: ctx.user.userId,
            targetKind: input.kind,
            targetId: input.targetId,
            ownerId: target.ownerId,
            reason: input.reason,
            note: input.note || null,
            snapshot: target.snapshot,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { reported: true as const };
        throw error;
      }

      const openReports = await openVerifiedReporters(input.kind, input.targetId);
      const hidden = input.kind !== 'user' && openReports >= AUTO_HIDE_REPORTERS;
      if (hidden) await setModerationHidden(input.kind, input.targetId, true);

      if (config.safetyAlertEmail) {
        sendSafetyReportAlert(config.safetyAlertEmail, {
          kind: input.kind,
          reason: input.reason,
          note: input.note,
          summary: alertSummary(input.kind, target),
          openReports,
          hidden,
        }).catch((error) => captureError(error, { flow: 'safety-report-alert' }));
      } else {
        console.warn('[safety] SAFETY_ALERT_EMAIL is not set; a new report was not emailed');
      }
      return { reported: true as const };
    }),

  /**
   * Block a member by id, or the owner of a party, review or sale by the item,
   * so the app never needs a host's or seller's account id to offer "Block".
   */
  block: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'safety-block' }))
    .input(z.union([
      z.object({ userId: memberId }),
      z.object({ kind: z.enum(REPORT_KINDS), targetId: z.string().min(1).max(128) }),
    ]))
    .mutation(async ({ ctx, input }) => {
      const userId = 'userId' in input ? input.userId : (await reportTarget(input.kind, input.targetId))?.ownerId;
      if (!userId) throw unavailable();
      if (userId === ctx.user.userId) throw new TRPCError({ code: 'BAD_REQUEST', message: "You can't block yourself." });
      const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'That member was not found.' });
      const already = await db.userBlock.findUnique({
        where: { blockerId_blockedId: { blockerId: ctx.user.userId, blockedId: target.id } },
        select: { id: true },
      });
      if (!already && await db.userBlock.count({ where: { blockerId: ctx.user.userId } }) >= MAX_BLOCKS) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `You can block up to ${MAX_BLOCKS} people. Unblock someone first.` });
      }
      await blockMember(ctx.user.userId, target.id);
      return { blocked: true as const };
    }),

  /** Unblocking restores nothing the block cleared. */
  unblock: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'safety-unblock' }))
    .input(z.object({ userId: memberId }))
    .mutation(async ({ ctx, input }) => {
      await db.userBlock.deleteMany({ where: { blockerId: ctx.user.userId, blockedId: input.userId } });
      return { blocked: false as const };
    }),

  /** The people this member blocked, newest first. Never who blocked them. */
  blocks: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'safety-blocks' }))
    .query(async ({ ctx }) => {
      const rows = await db.userBlock.findMany({
        where: { blockerId: ctx.user.userId },
        include: { blocked: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: MAX_BLOCKS,
      });
      return {
        blocks: rows.map((row) => ({
          userId: row.blocked.id,
          name: row.blocked.name?.trim() || 'Bytspot member',
          blockedAt: row.createdAt.toISOString(),
        })),
      };
    }),
});
