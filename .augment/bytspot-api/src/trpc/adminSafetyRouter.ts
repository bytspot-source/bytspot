/**
 * Admin Reports: member reports grouped by what was reported, and the
 * decision on each. Apple expects action within 24 hours, so the oldest open
 * item comes first.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { assertBytspotAdmin, auditAdminAction } from '../services/adminRbac';
import { signOutSessionsIssuedBefore } from '../services/accountDeletion';
import { REPORT_KINDS, markSessionsSuspended, setModerationHidden, type ReportKind } from '../services/safety';
import { signOutEverywhere } from '../vendor/refreshTokens';

const kind = z.enum(REPORT_KINDS);

/** Ends every sign-in, refuses new ones and hides what the member hosts or sells. */
async function suspendMember(userId: string, now = new Date()): Promise<void> {
  await db.user.updateMany({ where: { id: userId, suspendedAt: null }, data: { suspendedAt: now } });
  await markSessionsSuspended(userId, true);
  await signOutSessionsIssuedBefore(userId, now);
  await signOutEverywhere(userId, now.getTime(), 'member').catch((error) => captureError(error, { flow: 'safety-suspend' }));
}

export const adminSafetyRouter = router({
  reports: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-safety-reports' }))
    .input(z.object({ status: z.enum(['open', 'closed']).default('open') }).default({ status: 'open' }))
    .query(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.safety.reports' });
      const rows = await db.contentReport.findMany({
        where: input.status === 'open' ? { status: 'open' } : { status: { not: 'open' } },
        orderBy: { createdAt: input.status === 'open' ? 'asc' : 'desc' },
        take: 500,
      });
      const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
      const [owners, history] = await Promise.all([
        db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true, createdAt: true, suspendedAt: true } }),
        ownerIds.length > 0
          ? db.contentReport.groupBy({ by: ['ownerId', 'status'], where: { ownerId: { in: ownerIds } }, _count: { _all: true } })
          : Promise.resolve([]),
      ]);
      const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
      const items = new Map<string, {
        kind: ReportKind; targetId: string; snapshot: unknown; firstReportedAt: Date; status: string;
        decidedAt: Date | null; owner: unknown; reports: { reason: string; note: string | null; createdAt: Date }[];
      }>();
      for (const row of rows) {
        const key = `${row.targetKind}:${row.targetId}`;
        let item = items.get(key);
        if (!item) {
          const owner = ownerById.get(row.ownerId);
          const counts = history.filter((h) => h.ownerId === row.ownerId);
          item = {
            kind: row.targetKind as ReportKind,
            targetId: row.targetId,
            snapshot: row.snapshot,
            firstReportedAt: row.createdAt,
            status: row.status,
            decidedAt: row.decidedAt,
            owner: {
              userId: row.ownerId,
              name: owner?.name ?? null,
              email: owner?.email ?? null,
              memberSince: owner?.createdAt ?? null,
              suspendedAt: owner?.suspendedAt ?? null,
              reportsAgainst: counts.reduce((sum, h) => sum + h._count._all, 0),
              actedOn: counts.filter((h) => h.status === 'removed' || h.status === 'suspended').reduce((sum, h) => sum + h._count._all, 0),
            },
            reports: [],
          };
          items.set(key, item);
        }
        item.reports.push({ reason: row.reason, note: row.note, createdAt: row.createdAt });
      }
      const hidden = await hiddenTargets([...items.values()]);
      return {
        items: [...items.values()].map((item) => ({
          ...item,
          reporterCount: item.reports.length,
          hidden: hidden.has(`${item.kind}:${item.targetId}`),
        })),
      };
    }),

  /**
   * Dismiss: nothing wrong, the item shows again. Remove: the item stays
   * hidden. Suspend: the item stays hidden and its owner's account is
   * suspended. Every open report on the item is closed with the decision.
   */
  decide: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'admin-safety-decide' }))
    .input(z.object({ kind, targetId: z.string().min(1).max(128), action: z.enum(['dismiss', 'remove', 'suspend']) }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const open = await db.contentReport.findFirst({ where: { targetKind: input.kind, targetId: input.targetId, status: 'open' }, select: { ownerId: true } });
      if (!open) throw new TRPCError({ code: 'NOT_FOUND', message: 'No open reports on that.' });
      if (input.action === 'remove' && input.kind === 'user') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A person is suspended, not removed.' });
      }
      const now = new Date();
      if (input.action === 'dismiss') await setModerationHidden(input.kind, input.targetId, false);
      else await setModerationHidden(input.kind, input.targetId, true, now);
      if (input.action === 'suspend') await suspendMember(open.ownerId, now);
      const status = input.action === 'dismiss' ? 'dismissed' : input.action === 'remove' ? 'removed' : 'suspended';
      const closed = await db.contentReport.updateMany({
        where: { targetKind: input.kind, targetId: input.targetId, status: 'open' },
        data: { status, decidedById: ctx.user.userId, decidedAt: now },
      });
      auditAdminAction({
        actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.safety.decide',
        detail: { kind: input.kind, targetId: input.targetId, decision: status, ownerId: open.ownerId, reports: closed.count },
      });
      return { status };
    }),

  /** Lifts a suspension. What reports removed stays removed. */
  reinstate: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-safety-reinstate' }))
    .input(z.object({ userId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const updated = await db.user.updateMany({ where: { id: input.userId, suspendedAt: { not: null } }, data: { suspendedAt: null } });
      if (updated.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'That account is not suspended.' });
      await markSessionsSuspended(input.userId, false);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.safety.reinstate', detail: { userId: input.userId } });
      return { reinstated: true as const };
    }),
});

async function hiddenTargets(items: { kind: ReportKind; targetId: string }[]): Promise<Set<string>> {
  const ids = (k: ReportKind) => items.filter((item) => item.kind === k).map((item) => item.targetId);
  const hidden = { moderationHiddenAt: { not: null } };
  const [parties, reviews, sales] = await Promise.all([
    ids('party').length ? db.party.findMany({ where: { id: { in: ids('party') }, ...hidden }, select: { id: true } }) : [],
    ids('review').length ? db.review.findMany({ where: { id: { in: ids('review') }, ...hidden }, select: { id: true } }) : [],
    ids('sale').length ? db.privateSale.findMany({ where: { id: { in: ids('sale') }, ...hidden }, select: { id: true } }) : [],
  ]);
  return new Set([
    ...parties.map((row) => `party:${row.id}`),
    ...reviews.map((row) => `review:${row.id}`),
    ...sales.map((row) => `sale:${row.id}`),
  ]);
}
