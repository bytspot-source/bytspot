import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { serializableTransaction } from '../lib/transactions';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

/**
 * Plan — the control plane.
 *
 * A Plan is a structured representation of user intent that Bytspot
 * progressively turns into an executable real-world experience. It holds no
 * inventory and no money; it only references them.
 *
 * Three confirmations, three owners, never collapsed:
 *   - the creator confirms the Plan,
 *   - each participant confirms their own attendance,
 *   - a booking confirms inventory.
 *
 * Because nothing about a confirmed Plan costs anything, no participant quorum
 * gates it. What costs something — a hold, a payment — carries its own consent.
 */

const PROPOSED_PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PARTICIPANT_RESPONSES = ['accepted', 'maybe', 'declined'] as const;

/** A Plan is a coordination object, not a mailing list. */
const MAX_PLAN_PARTICIPANTS = 50;

/**
 * Capability is a fact about who controls fulfilment, so it is derived from the
 * room, never accepted from the caller. A room Bytspot settles is bookable; one
 * that only forwards a request is requestable; anything with no room behind it
 * is a reference the user resolves themselves.
 */
export function capabilityForAccessMode(accessMode: string): 'book' | 'request' | 'details' {
  if (accessMode === 'free-rsvp' || accessMode === 'paid-ticket') return 'book';
  if (accessMode === 'private-approval') return 'request';
  return 'details';
}

type PlanRecord = {
  lifecycle: string;
  startsAt: Date | null;
  endsAt: Date | null;
  expiresAt: Date | null;
  needs: string[];
};
type ParticipantRecord = { status: string };
type ItemRecord = { needKind: string; status: string; capability?: string };

/** A proposed Plan that ran out of time is expired on read; there is no sweep. */
export function isProposedPlanExpired(plan: PlanRecord, now: Date): boolean {
  return plan.lifecycle === 'proposed' && plan.expiresAt !== null && now >= plan.expiresAt;
}

/**
 * Booked, active, and completed are never stored. Deriving them is what stops
 * the control plane from claiming something the execution layer never did.
 */
export function planDisplayState(plan: PlanRecord, items: ItemRecord[], now: Date): string {
  if (plan.lifecycle === 'cancelled') return 'cancelled';
  if (plan.lifecycle === 'proposed') return isProposedPlanExpired(plan, now) ? 'expired' : 'proposed';
  // A lifecycle the database should not be able to hold is clamped to the
  // least-claiming state rather than echoed, so a bad row cannot render as
  // "booked" merely by being stored that way.
  if (plan.lifecycle !== 'confirmed') return 'proposed';

  if (plan.endsAt && now >= plan.endsAt) return 'completed';
  if (plan.startsAt && now >= plan.startsAt) return 'active';

  // A reference the user resolves themselves is not something Bytspot booked,
  // so a details item can never carry the Plan into `booked`.
  const live = items.filter((item) => item.status !== 'cancelled');
  if (live.length > 0 && live.every((item) => item.status === 'booked' && item.capability !== 'details')) return 'booked';
  return 'confirmed';
}

/** What the Plan is still missing. A need with no live item attached is open. */
export function openNeeds(plan: PlanRecord, items: ItemRecord[]): string[] {
  const filled = new Set(items.filter((item) => item.status !== 'cancelled').map((item) => item.needKind));
  return plan.needs.filter((need) => !filled.has(need));
}

/**
 * Readiness always travels beside the Plan's state. "Confirmed" alone would
 * overstate a creator's decision; "Confirmed · 2 going · 1 pending" cannot.
 */
export function planReadiness(participants: ParticipantRecord[]) {
  const count = (status: string) => participants.filter((p) => p.status === status).length;
  return {
    going: count('accepted'),
    maybe: count('maybe'),
    pending: count('invited'),
    declined: count('declined'),
    total: participants.filter((p) => p.status !== 'removed').length,
  };
}

const planInclude = {
  participants: { orderBy: { createdAt: 'asc' } },
  items: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.PlanInclude;

type LoadedPlan = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

function serializePlan(plan: LoadedPlan, now: Date) {
  return {
    id: plan.id,
    title: plan.title,
    intent: plan.intent,
    creatorUserId: plan.creatorUserId,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
    areaLabel: plan.areaLabel,
    partySize: plan.partySize,
    needs: plan.needs,
    lifecycle: plan.lifecycle,
    state: planDisplayState(plan, plan.items, now),
    readiness: planReadiness(plan.participants),
    openNeeds: openNeeds(plan, plan.items),
    participants: plan.participants.map((p) => ({ userId: p.userId, role: p.role, status: p.status })),
    items: plan.items.map((item) => ({
      id: item.id,
      needKind: item.needKind,
      title: item.title,
      partyId: item.partyId,
      capability: item.capability,
      status: item.status,
    })),
  };
}

/** A Plan is indistinguishable from a deleted one to anyone not on it. */
const planNotFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found.' });

type TxClient = Prisma.TransactionClient | typeof db;

/**
 * Removal ends access; declining does not. Someone who said no should still be
 * able to see the Plan and change their mind.
 */
async function loadPlanForParticipant(planId: string, userId: string, tx: TxClient = db): Promise<LoadedPlan> {
  const plan = await tx.plan.findUnique({ where: { id: planId }, include: planInclude });
  if (!plan) throw planNotFound();
  const seat = plan.participants.find((p) => p.userId === userId);
  if (!seat || seat.status === 'removed') throw planNotFound();
  return plan;
}

async function loadPlanForCreator(planId: string, userId: string, tx: TxClient = db): Promise<LoadedPlan> {
  const plan = await tx.plan.findUnique({ where: { id: planId }, include: planInclude });
  if (!plan || plan.creatorUserId !== userId) throw planNotFound();
  return plan;
}

/** The creator may only reshape a Plan that is still going somewhere. */
function assertPlanMutable(plan: LoadedPlan, now: Date) {
  if (plan.lifecycle === 'cancelled') throw new TRPCError({ code: 'CONFLICT', message: 'This Plan was cancelled.' });
  if (isProposedPlanExpired(plan, now)) throw new TRPCError({ code: 'CONFLICT', message: 'This Plan expired.' });
}

export const planRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'plan-create' }))
    .input(
      z.object({
        idempotencyKey: z.string().uuid(),
        title: z.string().trim().min(1).max(80),
        intent: z.string().trim().min(1).max(280),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
        areaLabel: z.string().trim().max(80).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        partySize: z.number().int().min(1).max(200).optional(),
        needs: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A Plan cannot end before it starts.' });
      }
      const key = { creatorUserId_idempotencyKey: { creatorUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } };
      const existing = await db.plan.findUnique({ where: key });
      if (existing) return { id: existing.id };

      const expiresAt = input.startsAt ?? new Date(Date.now() + PROPOSED_PLAN_TTL_MS);
      try {
        const plan = await db.plan.create({
          data: {
            creatorUserId: ctx.user.userId,
            idempotencyKey: input.idempotencyKey,
            title: input.title,
            intent: input.intent,
            startsAt: input.startsAt ?? null,
            endsAt: input.endsAt ?? null,
            areaLabel: input.areaLabel ?? null,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            partySize: input.partySize ?? null,
            needs: [...new Set(input.needs)],
            expiresAt,
            // The creator is on their own Plan, and is already going.
            participants: { create: { userId: ctx.user.userId, role: 'creator', status: 'accepted', respondedAt: new Date() } },
          },
        });
        return { id: plan.id };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const concurrent = await db.plan.findUnique({ where: key });
        if (concurrent) return { id: concurrent.id };
        throw error;
      }
    }),

  get: protectedProcedure
    .input(z.object({ planId: z.string().min(1) }))
    .query(async ({ ctx, input }) => serializePlan(await loadPlanForParticipant(input.planId, ctx.user.userId), new Date())),

  list: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const plans = await db.plan.findMany({
      where: { participants: { some: { userId: ctx.user.userId, status: { not: 'removed' } } } },
      include: planInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { plans: plans.map((plan) => serializePlan(plan, now)) };
  }),

  /** Only the creator confirms, and only their own decision is recorded. */
  confirm: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'plan-confirm' }))
    .input(z.object({ planId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      if (plan.lifecycle === 'confirmed') return { id: plan.id, lifecycle: plan.lifecycle };
      // Conditioned on the row still being proposed, so a cancel that lands
      // between the read and the write cannot be overwritten here.
      const confirmed = await db.plan.updateMany({
        where: { id: plan.id, lifecycle: 'proposed' },
        data: { lifecycle: 'confirmed', confirmedAt: now, expiresAt: null },
      });
      if (confirmed.count === 0) {
        const current = await db.plan.findUnique({ where: { id: plan.id }, select: { lifecycle: true } });
        if (current?.lifecycle === 'confirmed') return { id: plan.id, lifecycle: 'confirmed' };
        throw new TRPCError({ code: 'CONFLICT', message: 'This Plan was cancelled.' });
      }
      return { id: plan.id, lifecycle: 'confirmed' };
    }),

  /** Cancelling is terminal, and always wins a race against confirming. */
  cancel: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'plan-cancel' }))
    .input(z.object({ planId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      if (plan.lifecycle === 'cancelled') return { id: plan.id, lifecycle: plan.lifecycle };
      await db.plan.updateMany({
        where: { id: plan.id, lifecycle: { not: 'cancelled' } },
        data: { lifecycle: 'cancelled', cancelledAt: new Date() },
      });
      return { id: plan.id, lifecycle: 'cancelled' };
    }),

  /**
   * Invite takes a userId and deliberately performs no relationship check.
   * Spot Code exists to introduce strangers, so a prior-relationship gate here
   * would reject the very handoff it is meant to enable.
   */
  invite: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-invite' }))
    .input(z.object({ planId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      if (input.userId === ctx.user.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You are already on this Plan.' });
      }
      const invitee = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!invitee) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person could not be found.' });

      // Reading a limit and then writing against it has to say Serializable
      // out loud: two concurrent invites to different users would both pass a
      // stale cap check and push the Plan past MAX_PLAN_PARTICIPANTS.
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForCreator(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);

        // Re-read on the transaction client so a P2002 is a true race, not a
        // predictable outcome. An expected unique violation inside a Postgres
        // transaction aborts it and every following statement fails.
        const existing = await tx.planParticipant.findUnique({
          where: { planId_userId: { planId: fresh.id, userId: input.userId } },
          select: { status: true },
        });
        if (existing && existing.status !== 'removed') return { status: existing.status };

        if (fresh.participants.filter((p) => p.status !== 'removed').length >= MAX_PLAN_PARTICIPANTS) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This Plan is full.' });
        }

        if (existing) {
          // Reviving only removed rows keeps this from overwriting an answer
          // someone has already given.
          await tx.planParticipant.update({
            where: { planId_userId: { planId: fresh.id, userId: input.userId } },
            data: { status: 'invited', respondedAt: null },
          });
          return { status: 'invited' as const };
        }

        try {
          const created = await tx.planParticipant.create({
            data: { planId: fresh.id, userId: input.userId, role: 'guest', status: 'invited' },
          });
          return { status: created.status };
        } catch (error) {
          // A concurrent invite of the same person raced us. Let Serializable
          // do its job and surface the conflict at the transaction boundary.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new TRPCError({ code: 'CONFLICT', message: 'Another change to this Plan is in flight. Try again.' });
          }
          throw error;
        }
      }, 'Another change to this Plan is in flight. Try again.');
    }),

  /** A participant answers only for themselves. */
  respond: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-respond' }))
    .input(z.object({ planId: z.string().min(1), response: z.enum(PARTICIPANT_RESPONSES) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForParticipant(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      // Re-read the Plan inside the transaction so a cancel that lands after
      // the initial load cannot be followed by a response on a dead Plan.
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForParticipant(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);
        const answered = await tx.planParticipant.updateMany({
          where: { planId: fresh.id, userId: ctx.user.userId, status: { not: 'removed' } },
          data: { status: input.response, respondedAt: now },
        });
        if (answered.count === 0) throw planNotFound();
        return { status: input.response };
      }, 'Another change to this Plan is in flight. Try again.');
    }),

  remove: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-remove' }))
    .input(z.object({ planId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      if (input.userId === ctx.user.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cancel the Plan instead of removing yourself.' });
      }
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForCreator(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);
        const removed = await tx.planParticipant.updateMany({
          where: { planId: fresh.id, userId: input.userId, status: { not: 'removed' } },
          data: { status: 'removed', respondedAt: now },
        });
        if (removed.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person is not on this Plan.' });
        return { status: 'removed' as const };
      }, 'Another change to this Plan is in flight. Try again.');
    }),

  setNeeds: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-needs' }))
    .input(z.object({ planId: z.string().min(1), needs: z.array(z.string().trim().min(1).max(40)).max(12) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      const needs = [...new Set(input.needs)];
      await db.plan.update({ where: { id: plan.id }, data: { needs } });
      return { needs, openNeeds: openNeeds({ ...plan, needs }, plan.items) };
    }),

  /**
   * Attaching supply. The caller never states the capability: it is read off
   * the room, so a Plan cannot advertise a booking Bytspot does not control.
   * An item with no room behind it is a reference, and stays `details`.
   */
  attach: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-attach' }))
    .input(
      z.object({
        planId: z.string().min(1),
        needKind: z.string().trim().min(1).max(40),
        title: z.string().trim().min(1).max(120).optional(),
        partyId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);

      let capability: 'book' | 'request' | 'details' = 'details';
      let title = input.title;
      if (input.partyId) {
        const party = await db.party.findFirst({
          where: { id: input.partyId, status: 'published' },
          select: { id: true, title: true, accessMode: true },
        });
        if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'That room could not be found.' });
        capability = capabilityForAccessMode(party.accessMode);
        // The room names itself; a caller-supplied title cannot misrepresent it.
        title = party.title;
      }
      if (!title) throw new TRPCError({ code: 'BAD_REQUEST', message: 'This item needs a title.' });

      const item = await db.planItem.create({
        data: { planId: plan.id, needKind: input.needKind, title, capability, partyId: input.partyId ?? null },
      });
      return { id: item.id, capability: item.capability, status: item.status };
    }),

  /** Detach cancels the item; Plan history is never rewritten. */
  detach: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-detach' }))
    .input(z.object({ planId: z.string().min(1), itemId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      const item = plan.items.find((candidate) => candidate.id === input.itemId);
      if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'That item is not on this Plan.' });
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForCreator(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);
        // Conditional on the item not having reached booked between the read
        // and the write, so a booking is never silently stranded.
        const cancelled = await tx.planItem.updateMany({
          where: { id: item.id, status: { not: 'booked' } },
          data: { status: 'cancelled' },
        });
        if (cancelled.count === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Cancel the booking before removing it from the Plan.' });
        }
        return { status: 'cancelled' as const };
      }, 'Another change to this Plan is in flight. Try again.');
    }),
});
