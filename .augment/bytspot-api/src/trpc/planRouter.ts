import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { serializableTransaction } from '../lib/transactions';
import { coffeeToBookableSnapshot, partyToBookableSnapshot, type BookableSnapshot } from '../services/bookableProjection';
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

/**
 * Phase 2: the same rule generalized across supply kinds. A coffee
 * reservation is a hold ask, not a payment, so it derives to `request`.
 * Neither supply present is a reference the user resolves themselves.
 */
export function capabilityForSupply(supply: { party?: { accessMode: string } | null; reservation?: unknown }): 'book' | 'request' | 'details' {
  if (supply.party) return capabilityForAccessMode(supply.party.accessMode);
  if (supply.reservation) return 'request';
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
  // Items include the reservation summary they point at so the client can
  // render a hold countdown without a second round-trip. Only fields a
  // Plans row actually paints are selected; owner and idempotency stay
  // server-side, and the reservation summary is null for room-backed items.
  items: {
    orderBy: { createdAt: 'asc' },
    include: { coffeeReservation: { select: { holdExpiresAt: true, status: true } } },
  },
} satisfies Prisma.PlanInclude;

type LoadedPlan = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

/** The invite-link credential. 192 bits of randomness, url-safe for the path. */
function newJoinToken(): string {
  return randomBytes(24).toString('base64url');
}

function serializePlan(plan: LoadedPlan, now: Date, viewerUserId: string) {
  return {
    id: plan.id,
    title: plan.title,
    intent: plan.intent,
    creatorUserId: plan.creatorUserId,
    // The join link is a bearer secret, so only the creator is handed it; a
    // guest sees the Plan but cannot silently reshare a seat to it.
    joinToken: plan.creatorUserId === viewerUserId ? plan.joinToken : undefined,
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
      coffeeReservationId: item.coffeeReservationId,
      capability: item.capability,
      status: item.status,
      // A room item has no reservation summary; the field is always null in
      // that case so the client can key hold-countdown rendering off it.
      reservation: item.coffeeReservation
        ? { holdExpiresAt: item.coffeeReservation.holdExpiresAt, status: item.coffeeReservation.status }
        : null,
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

// The single site where supply becomes a capability and a Bookable snapshot,
// shared by attach and createSolo so control derives from capability in exactly
// one place (contract §8). No supply behind it → a details reference that
// promises nothing. The caller never states the capability: it is derived.
async function resolveSupply(
  userId: string,
  input: { partyId: string | null; coffeeReservationId: string | null; title?: string },
): Promise<{
  capability: 'book' | 'request' | 'details';
  title: string;
  snapshot: BookableSnapshot | null;
  partyId: string | null;
  coffeeReservationId: string | null;
}> {
  const { partyId, coffeeReservationId } = input;
  if (partyId && coffeeReservationId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'An item can carry only one supply.' });
  }

  let capability: 'book' | 'request' | 'details' = 'details';
  let title = input.title;
  let snapshot: BookableSnapshot | null = null;

  if (partyId) {
    const party = await db.party.findFirst({
      where: { id: partyId, status: 'published' },
      select: { id: true, title: true, accessMode: true, requiredMembershipTier: true },
    });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'That room could not be found.' });
    capability = capabilityForSupply({ party });
    // The room names itself; a caller-supplied title cannot misrepresent it.
    title = party.title;
    snapshot = partyToBookableSnapshot({ partyId: party.id, title: party.title, capability, accessMode: party.accessMode, requiredMembershipTier: party.requiredMembershipTier });
  } else if (coffeeReservationId) {
    const reservation = await db.coffeeReservation.findFirst({
      where: { id: coffeeReservationId, requestedByUserId: userId, status: { in: ['pending', 'confirmed'] as const } },
      select: { id: true, spot: { select: { name: true } } },
    });
    // Not-yours and not-found read the same, mirroring the party rule so one
    // caller cannot enumerate another caller's reservations.
    if (!reservation) throw new TRPCError({ code: 'NOT_FOUND', message: 'That coffee reservation could not be found.' });
    capability = capabilityForSupply({ reservation });
    title = reservation.spot.name;
    snapshot = coffeeToBookableSnapshot({ coffeeReservationId: reservation.id, title: reservation.spot.name });
  }

  if (!title) throw new TRPCError({ code: 'BAD_REQUEST', message: 'This item needs a title.' });
  return { capability, title, snapshot, partyId, coffeeReservationId };
}

// The Bookable snapshot as Prisma create data — one mapping, so attach and
// createSolo cannot drift.
function bookableCreateData(snapshot: BookableSnapshot) {
  return {
    id: snapshot.id,
    sourceKind: snapshot.sourceKind,
    capability: snapshot.capability,
    provider: snapshot.provider,
    tierName: snapshot.tierName,
    priceCents: snapshot.priceCents,
    capacity: snapshot.capacity,
    membershipFloor: snapshot.membershipFloor,
    fulfillment: snapshot.fulfillment as Prisma.InputJsonValue,
  };
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
            joinToken: newJoinToken(),
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
    .query(async ({ ctx, input }) => serializePlan(await loadPlanForParticipant(input.planId, ctx.user.userId), new Date(), ctx.user.userId)),

  list: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const plans = await db.plan.findMany({
      where: { participants: { some: { userId: ctx.user.userId, status: { not: 'removed' } } } },
      include: planInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { plans: plans.map((plan) => serializePlan(plan, now, ctx.user.userId)) };
  }),

  /**
   * Join by link. The token is the credential the creator shared out-of-band
   * — a text they sent from their own device — so holding it is what seats you.
   * This is the one Plan write that does not start from an existing seat. You
   * join as a guest with status `invited`: you are on the Plan, but your own
   * attendance is still yours to confirm.
   */
  joinByToken: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'plan-join' }))
    .input(z.object({ token: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      // Reading the cap and then writing against it has to say Serializable out
      // loud, exactly as invite does: concurrent joins could each pass a stale
      // cap check and push the Plan past MAX_PLAN_PARTICIPANTS.
      return serializableTransaction(async (tx) => {
        const plan = await tx.plan.findUnique({ where: { joinToken: input.token }, include: planInclude });
        // A closed or unknown link is indistinguishable from a Plan that never
        // existed — the same wall a non-participant hits everywhere else.
        if (
          !plan ||
          plan.lifecycle === 'cancelled' ||
          isProposedPlanExpired(plan, now) ||
          (plan.lifecycle === 'confirmed' && plan.endsAt && now >= plan.endsAt)
        ) {
          throw planNotFound();
        }

        const seat = plan.participants.find((p) => p.userId === ctx.user.userId);
        if (seat) {
          // A removed guest does not get back in by reusing the link.
          if (seat.status === 'removed') throw planNotFound();
          return serializePlan(plan, now, ctx.user.userId);
        }

        if (plan.participants.filter((p) => p.status !== 'removed').length >= MAX_PLAN_PARTICIPANTS) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This Plan is full.' });
        }

        try {
          await tx.planParticipant.create({
            data: { planId: plan.id, userId: ctx.user.userId, role: 'guest', status: 'invited' },
          });
        } catch (error) {
          // A concurrent join of the same user raced us; Serializable turns it
          // into a retryable conflict rather than a duplicate seat.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new TRPCError({ code: 'CONFLICT', message: 'Another change to this Plan is in flight. Try again.' });
          }
          throw error;
        }

        // The loaded snapshot plus the seat just written is the current state;
        // returning it avoids a second read of a row we already know.
        plan.participants.push({
          id: 'pending', planId: plan.id, userId: ctx.user.userId, role: 'guest',
          status: 'invited', respondedAt: null, createdAt: now, updatedAt: now,
        } as LoadedPlan['participants'][number]);
        return serializePlan(plan, now, ctx.user.userId);
      }, 'Another change to this Plan is in flight. Try again.');
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
   * Attaching supply. The caller never states the capability: it is derived
   * from the supply, so a Plan cannot advertise a booking Bytspot does not
   * control. Phase 2 accepts a generic `supplyRef` alongside the legacy
   * top-level `partyId`; a caller may set at most one supply. An item with
   * no supply behind it is a reference, and stays `details`.
   */
  attach: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-attach' }))
    .input(
      z.object({
        planId: z.string().min(1),
        needKind: z.string().trim().min(1).max(40),
        title: z.string().trim().min(1).max(120).optional(),
        // Legacy top-level partyId is kept for one release so unshipped iOS
        // builds do not break; a follow-up removes it. Prefer supplyRef.
        partyId: z.string().min(1).optional(),
        supplyRef: z
          .object({
            partyId: z.string().min(1).optional(),
            coffeeReservationId: z.string().min(1).optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);

      const partyId = input.supplyRef?.partyId ?? input.partyId ?? null;
      const coffeeReservationId = input.supplyRef?.coffeeReservationId ?? null;
      const supply = await resolveSupply(ctx.user.userId, { partyId, coffeeReservationId, title: input.title });

      try {
        // The snapshot and the item are written together: the item never points
        // at a handle that was not persisted, and a reference item (no supply)
        // writes no handle at all.
        const item = await db.$transaction(async (tx) => {
          if (supply.snapshot) await tx.bookable.create({ data: bookableCreateData(supply.snapshot) });
          return tx.planItem.create({
            data: {
              planId: plan.id,
              needKind: input.needKind,
              title: supply.title,
              capability: supply.capability,
              partyId: supply.partyId,
              coffeeReservationId: supply.coffeeReservationId,
              bookableId: supply.snapshot?.id ?? null,
            },
          });
        });
        return { id: item.id, capability: item.capability, status: item.status };
      } catch (error) {
        // A racing attach of the same reservation to another Plan trips the
        // unique constraint on plan_items.coffee_reservation_id.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new TRPCError({ code: 'CONFLICT', message: 'That reservation is already on another Plan.' });
        }
        throw error;
      }
    }),

  /**
   * The booking spine — "every booking is a Plan of one". A lone bookable is
   * still a Plan: this creates a single-need Plan, seated by the caller, with
   * the supply already attached, in one transaction — so the rest of the system
   * (roll-up, recap, Prime Path) only ever reasons about Plans.
   *
   * It settles nothing and mints no Pass: the item stays `available` and the
   * capability is derived, never asserted. Actual settlement remains the
   * existing per-supply path (B3b flips the item to `booked` and freezes the
   * snapshot). Supply is required — a solo Plan with nothing behind it would be
   * an empty Plan, not a booking.
   */
  createSolo: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'plan-create-solo' }))
    .input(
      z.object({
        idempotencyKey: z.string().uuid(),
        needKind: z.string().trim().min(1).max(40),
        supplyRef: z.object({
          partyId: z.string().min(1).optional(),
          coffeeReservationId: z.string().min(1).optional(),
        }),
        title: z.string().trim().min(1).max(80).optional(),
        intent: z.string().trim().min(1).max(280).optional(),
        areaLabel: z.string().trim().max(80).optional(),
        partySize: z.number().int().min(1).max(200).optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A Plan cannot end before it starts.' });
      }
      const key = { creatorUserId_idempotencyKey: { creatorUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } };
      const existing = await db.plan.findUnique({ where: key });
      if (existing) return { id: existing.id };

      const partyId = input.supplyRef.partyId ?? null;
      const coffeeReservationId = input.supplyRef.coffeeReservationId ?? null;
      const supply = await resolveSupply(ctx.user.userId, { partyId, coffeeReservationId, title: input.title });
      if (!supply.partyId && !supply.coffeeReservationId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A solo Plan needs one supply.' });
      }

      // The supply names the Plan when the caller does not, so a solo Plan
      // cannot claim to be something other than the thing it wraps.
      const title = input.title ?? supply.title;
      const intent = input.intent ?? supply.title;
      const expiresAt = input.startsAt ?? new Date(Date.now() + PROPOSED_PLAN_TTL_MS);

      try {
        const created = await db.$transaction(async (tx) => {
          const plan = await tx.plan.create({
            data: {
              creatorUserId: ctx.user.userId,
              idempotencyKey: input.idempotencyKey,
              title,
              intent,
              startsAt: input.startsAt ?? null,
              endsAt: input.endsAt ?? null,
              areaLabel: input.areaLabel ?? null,
              latitude: null,
              longitude: null,
              partySize: input.partySize ?? null,
              joinToken: newJoinToken(),
              needs: [input.needKind],
              expiresAt,
              // The creator is on their own Plan, and is already going.
              participants: { create: { userId: ctx.user.userId, role: 'creator', status: 'accepted', respondedAt: new Date() } },
            },
          });
          if (supply.snapshot) await tx.bookable.create({ data: bookableCreateData(supply.snapshot) });
          await tx.planItem.create({
            data: {
              planId: plan.id,
              needKind: input.needKind,
              title: supply.title,
              capability: supply.capability,
              partyId: supply.partyId,
              coffeeReservationId: supply.coffeeReservationId,
              bookableId: supply.snapshot?.id ?? null,
            },
          });
          return { id: plan.id };
        });
        return created;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // Either our own idempotency replay raced us — return that Plan — or the
          // supply is already on another Plan, the same wall attach puts up.
          const concurrent = await db.plan.findUnique({ where: key });
          if (concurrent) return { id: concurrent.id };
          throw new TRPCError({ code: 'CONFLICT', message: 'That reservation is already on another Plan.' });
        }
        throw error;
      }
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
