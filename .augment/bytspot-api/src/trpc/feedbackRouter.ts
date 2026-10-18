/**
 * Feedback — a member's private rating of a Party, Plan, or venue they were at.
 *
 * Unlike venue reviews, nothing here is public. A host reads a count and an
 * average for their own Party (Party Control summary) and never a note or a
 * name, so a guest can be honest about a room whose host knows them.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { partyMediaUrl } from './partyRouter';
import { endedAt, FALLBACK_LENGTH_MS } from '../services/scheduledPushes';

const PENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const targetKind = z.enum(['party', 'plan', 'venue']);
const target = { targetKind, targetId: z.string().min(1).max(128) };

const PARTY_ATTENDED = { OR: [{ accessGranted: true }, { checkedInAt: { not: null } }] };
const PLAN_PRESENT = { status: { notIn: ['declined', 'removed'] } };
const PLAN_LIVE = { deletedAt: null, cancelledAt: null, lifecycle: { not: 'cancelled' } };

function endedBetween(since: Date, now: Date) {
  return [
    { endsAt: { gt: since, lte: now } },
    { endsAt: null, startsAt: { gt: new Date(since.getTime() - FALLBACK_LENGTH_MS), lte: new Date(now.getTime() - FALLBACK_LENGTH_MS) } },
  ];
}

const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'Nothing to rate here.' });

/** Only someone who was there may rate it, and only once it has begun. */
async function assertCanRate(userId: string, kind: z.infer<typeof targetKind>, targetId: string, now: Date): Promise<void> {
  if (kind === 'party') {
    const guest = await db.partyGuest.findFirst({
      where: { userId, partyId: targetId, ...PARTY_ATTENDED, party: { status: 'published', startsAt: { lte: now } } },
      select: { id: true },
    });
    if (!guest) throw notFound();
    return;
  }
  if (kind === 'plan') {
    const seat = await db.planParticipant.findFirst({
      where: { userId, planId: targetId, ...PLAN_PRESENT, plan: PLAN_LIVE },
      select: { plan: { select: { startsAt: true, endsAt: true } } },
    });
    const began = seat ? (seat.plan.startsAt ?? seat.plan.endsAt) : null;
    if (!began || began > now) throw notFound();
    return;
  }
  const venue = await db.venue.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!venue) throw notFound();
}

export const feedbackRouter = router({
  /** What this member was at that ended in the last week and is not yet rated or dismissed. */
  pending: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const since = new Date(now.getTime() - PENDING_WINDOW_MS);
    const userId = ctx.user.userId;
    const [guests, seats] = await Promise.all([
      db.partyGuest.findMany({
        where: { userId, ...PARTY_ATTENDED, party: { status: 'published', moderationHiddenAt: null, OR: endedBetween(since, now) } },
        select: { party: { select: { id: true, title: true, startsAt: true, endsAt: true } } },
        take: 50,
      }),
      db.planParticipant.findMany({
        where: { userId, ...PLAN_PRESENT, plan: { ...PLAN_LIVE, OR: endedBetween(since, now) } },
        select: { plan: { select: { id: true, title: true, startsAt: true, endsAt: true } } },
        take: 50,
      }),
    ]);
    const candidates = [
      ...guests.map(({ party }) => ({ targetKind: 'party' as const, targetId: party.id, title: party.title, ended: endedAt(party) })),
      ...seats.map(({ plan }) => ({ targetKind: 'plan' as const, targetId: plan.id, title: plan.title, ended: endedAt(plan) })),
    ].filter((c): c is typeof c & { ended: Date } => c.ended !== null && c.ended <= now && c.ended > since);
    if (candidates.length === 0) return { pending: [] };

    const ids = candidates.map((c) => c.targetId);
    const partyIds = candidates.filter((c) => c.targetKind === 'party').map((c) => c.targetId);
    const [rated, dismissed, covers] = await Promise.all([
      db.feedback.findMany({ where: { userId, targetId: { in: ids } }, select: { targetKind: true, targetId: true } }),
      db.feedbackDismissal.findMany({ where: { userId, targetId: { in: ids } }, select: { targetKind: true, targetId: true } }),
      partyIds.length > 0
        ? db.partyMedia.findMany({ where: { partyId: { in: partyIds }, kind: 'cover' }, select: { id: true, partyId: true } })
        : [],
    ]);
    const settled = new Set([...rated, ...dismissed].map((row) => `${row.targetKind}:${row.targetId}`));
    const coverMap = new Map(covers.map((media) => [media.partyId, partyMediaUrl(media.id)]));
    return {
      pending: candidates
        .filter((c) => !settled.has(`${c.targetKind}:${c.targetId}`))
        .sort((a, b) => b.ended.getTime() - a.ended.getTime())
        .map((c) => ({
          targetKind: c.targetKind,
          targetId: c.targetId,
          title: c.title,
          coverURL: c.targetKind === 'party' ? coverMap.get(c.targetId) ?? null : null,
          endedAt: c.ended.toISOString(),
        })),
    };
  }),

  /** Rate something once; a second submit replaces the first. */
  submit: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'feedback-submit' }))
    .input(z.object({
      ...target,
      rating: z.number().int().min(1).max(5),
      tags: z.array(z.string().trim().min(1).max(40)).max(10).optional().default([]),
      note: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.userId;
      await assertCanRate(userId, input.targetKind, input.targetId, new Date());
      const tags = [...new Set(input.tags)];
      const note = input.note ? input.note : null;
      const row = await db.feedback.upsert({
        where: { userId_targetKind_targetId: { userId, targetKind: input.targetKind, targetId: input.targetId } },
        create: { userId, targetKind: input.targetKind, targetId: input.targetId, rating: input.rating, tags, note },
        update: { rating: input.rating, tags, note },
      });
      return {
        targetKind: input.targetKind,
        targetId: row.targetId,
        rating: row.rating,
        tags: row.tags,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
      };
    }),

  /** "Not now" — the prompt does not come back. */
  dismiss: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'feedback-dismiss' }))
    .input(z.object(target))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.userId;
      await db.feedbackDismissal.upsert({
        where: { userId_targetKind_targetId: { userId, targetKind: input.targetKind, targetId: input.targetId } },
        create: { userId, targetKind: input.targetKind, targetId: input.targetId },
        update: {},
      });
      return { targetKind: input.targetKind, targetId: input.targetId, dismissed: true as const };
    }),
});
