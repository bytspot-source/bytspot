import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { categoryForDomain, DEMAND_DEFAULTS, demandCategoryIds } from '../vendor/demand';
import { ASK_INTENT, supplyFor } from '../vendor/demandFeed';
import { sellableSlots } from '../vendor/availability';
import { constraintsFromPlan, refusalMessage, type DemandEnvelope } from '../vendor/planDemand';
import { openNeeds } from './planRouter';
import { acceptOffer, NotYours, OfferExpired, OfferGone, SlotTaken } from '../vendor/acceptOffer';

/**
 * Demand — intent published before supply is known.
 *
 * The other half of the vendor feed. A Demand is a guest saying what they want
 * without naming who should provide it; sellers answer it from their own
 * capacity, and the match rules decide whether anyone can.
 *
 * It holds no inventory and no money. Publishing one commits the guest to
 * nothing, which is the point: the cost of asking has to be near zero or
 * nobody asks, and a feed of real unanswered wants is what tells a vendor
 * what to change.
 *
 * Bounds come from the contract rather than from this file, so the console,
 * the API and the database agree on what a demand may ask for.
 */

/** The most live requests one person may have outstanding at once. */
const MAX_LIVE_PER_USER = 5;

const LIVE_STATES = ['OPEN', 'MATCHED', 'OFFERED'];

/**
 * The longest an offer may run, enforced by `offers_shape_sane`.
 *
 * A booking stays visible until the table has finished, which is
 * `startsAt + durationMins`. Prisma cannot express that arithmetic in a
 * `where`, so the query prefilters on `startsAt` by this much and applies the
 * exact end time in code. The prefilter is only sound because the database
 * refuses a longer offer.
 */
const MAX_OFFER_DURATION_MINS = 1440;

const publishInput = z.object({
  // Validated against the contract, not a local list. Only these carry the
  // domains the category match rule reads; a Discover rail would be unmatchable.
  category: z.enum(demandCategoryIds() as [string, ...string[]]),
  partySize: z.number().int().min(1).max(DEMAND_DEFAULTS.maxPartySize),
  earliest: z.coerce.date(),
  latest: z.coerce.date(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMiles: z.number().positive().max(DEMAND_DEFAULTS.maxRadiusMiles).optional(),
  budgetCents: z.number().int().positive().max(100_000_00).optional(),
  note: z.string().trim().max(280).optional(),
  planId: z.string().trim().min(1).max(64).optional(),
});

/**
 * Everything true of a request however it was raised.
 *
 * Shared so that demand emitted by a Plan cannot drift away from demand a guest
 * typed: the cap, the expiry rule and the event are one implementation, not two
 * that happen to agree today.
 */
async function raiseDemand(
  userId: string,
  envelope: DemandEnvelope,
  extras: {
    planId?: string | null;
    radiusMiles?: number;
    budgetCents?: number;
    note?: string | null;
    targetWindowId?: string;
  },
  now: Date,
) {
  const live = await db.demand.count({
    where: { raisedByUserId: userId, state: { in: LIVE_STATES }, expiresAt: { gt: now } },
  });
  if (live >= MAX_LIVE_PER_USER) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'You have too many open requests. Let one land or expire first.',
    });
  }

  // A demand must not outlive the window it asks about. The contract's expiry
  // is the longest anyone waits; a request for dinner tonight stops being a
  // request the moment tonight is over.
  const contractExpiry = new Date(now.getTime() + DEMAND_DEFAULTS.expiryMins * 60_000);
  const expiresAt = contractExpiry < envelope.latest ? contractExpiry : envelope.latest;

  const demand = await db.demand.create({
    data: {
      planId: extras.planId ?? null,
      raisedByUserId: userId,
      category: envelope.category,
      partySize: envelope.partySize,
      earliest: envelope.earliest,
      latest: envelope.latest,
      latitude: envelope.latitude,
      longitude: envelope.longitude,
      radiusMiles: extras.radiusMiles ?? DEMAND_DEFAULTS.radiusMiles,
      budgetCents: extras.budgetCents ?? null,
      note: extras.note || null,
      targetWindowId: extras.targetWindowId ?? null,
      expiresAt,
    },
  });

  await db.demandEvent.create({ data: { demandId: demand.id, kind: 'PUBLISHED' } });

  return {
    id: demand.id,
    state: demand.state,
    category: demand.category,
    expiresAt: demand.expiresAt.toISOString(),
    raisedAt: demand.raisedAt.toISOString(),
  };
}

/** How long past the chosen slot a seller may still offer, before the contract's flexibility. */
const ASK_SPAN_MINS = 15;


export const demandRouter = router({
  /**
   * Raise a need.
   *
   * Rate limited and capped because this is the one endpoint where a single
   * guest can write into every vendor's feed in a city. The limit is per user
   * rather than per client, so a second device does not double the budget.
   */
  publish: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60 * 60 * 1000, max: 20, label: 'demand-publish' }))
    .input(publishInput)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      if (input.latest <= input.earliest) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The window has to end after it starts.' });
      }

      // A request for a time that has already passed can never be answered, and
      // would sit in every matching seller's feed until it expired.
      if (input.latest <= now) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That time has already passed.' });
      }

      // Null Island is what a failed geolocation looks like. Accepting it would
      // publish a request nobody is near and no seller could ever reach.
      if (input.latitude === 0 && input.longitude === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'We could not tell where you are.' });
      }

      if (input.planId) {
        // Someone else's Plan is indistinguishable from one that does not
        // exist, so a caller cannot probe ids by attaching demand to them.
        const plan = await db.plan.findFirst({
          where: { id: input.planId, creatorUserId: ctx.user.userId },
          select: { id: true },
        });
        if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found.' });
      }

      return raiseDemand(
        ctx.user.userId,
        {
          category: input.category,
          partySize: input.partySize,
          earliest: input.earliest,
          latest: input.latest,
          latitude: input.latitude,
          longitude: input.longitude,
        },
        { planId: input.planId, radiusMiles: input.radiusMiles, budgetCents: input.budgetCents, note: input.note },
        now,
      );
    }),

  /**
   * Ask one seller, from their Discover card.
   *
   * The same demand as publish, aimed at one window: only its seller sees it,
   * and only that window can answer it. The time must be a slot the window can
   * actually sell to this party now, or the ask would sit unanswerable.
   */
  ask: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60 * 60 * 1000, max: 20, label: 'demand-ask' }))
    .input(
      z.object({
        windowId: z.string().trim().min(1).max(64),
        partySize: z.number().int().min(1).max(DEMAND_DEFAULTS.maxPartySize),
        startsAt: z.coerce.date(),
        note: z.string().trim().max(280).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const window = await db.vendorAvailabilityWindow.findFirst({
        where: {
          id: input.windowId,
          active: true,
          intent: ASK_INTENT,
          location: { state: 'ACTIVE' },
          seller: { state: 'ACTIVE' },
        },
        select: { id: true, sellerId: true, domain: true, maxGuests: true, location: { select: { lat: true, lng: true } } },
      });
      if (!window) throw new TRPCError({ code: 'NOT_FOUND', message: 'This is no longer taking requests.' });

      if (input.partySize > window.maxGuests) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `This takes up to ${window.maxGuests} guests.` });
      }

      const category = categoryForDomain(window.domain);
      if (!category) throw new TRPCError({ code: 'NOT_FOUND', message: 'This is no longer taking requests.' });

      const { supply } = await supplyFor(window.sellerId, now);
      const own = supply.find((item) => item.windowId === window.id);
      const slot = sellableSlots(own?.slots ?? [], window.domain, now).find(
        (candidate) => candidate.startsAt.getTime() === input.startsAt.getTime(),
      );
      if (!slot || slot.startsAt <= now || slot.remaining < input.partySize) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That time just went. Pick another.' });
      }

      const already = await db.demand.findFirst({
        where: {
          raisedByUserId: ctx.user.userId,
          targetWindowId: window.id,
          state: { in: LIVE_STATES },
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (already) throw new TRPCError({ code: 'CONFLICT', message: 'You have already asked here.' });

      return raiseDemand(
        ctx.user.userId,
        {
          category,
          partySize: input.partySize,
          earliest: slot.startsAt,
          latest: new Date(slot.startsAt.getTime() + ASK_SPAN_MINS * 60_000),
          latitude: window.location.lat,
          longitude: window.location.lng,
        },
        { note: input.note, targetWindowId: window.id },
        now,
      );
    }),

  /**
   * Ask on behalf of a Plan.
   *
   * The Plan already states when, where and how many, so a guest filling a gap
   * in one should not have to restate it — and could not restate it more
   * accurately than the Plan itself.
   *
   * Nothing here is inferred: a Plan that does not say enough is refused with
   * the reason, so the guest learns what to add rather than watching a request
   * expire unanswered.
   */
  fromPlan: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60 * 60 * 1000, max: 20, label: 'demand-from-plan' }))
    .input(
      z.object({
        planId: z.string().trim().min(1).max(64),
        needKind: z.string().trim().min(1).max(40),
        budgetCents: z.number().int().positive().max(100_000_00).optional(),
        note: z.string().trim().max(280).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      // Someone else's Plan is indistinguishable from one that does not exist.
      const plan = await db.plan.findFirst({
        where: { id: input.planId, creatorUserId: ctx.user.userId },
        select: {
          id: true,
          needs: true,
          startsAt: true,
          endsAt: true,
          latitude: true,
          longitude: true,
          partySize: true,
          items: { select: { needKind: true, status: true, coffeeSpotId: true, bookableId: true, partyId: true } },
        },
      });
      if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found.' });

      // A need the Plan never declared is not an unmet need; saying it is
      // "already sorted" would be false.
      if (!plan.needs.includes(input.needKind)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'This plan does not have that need.' });
      }

      // Openness is the Plan's own answer, not a second opinion computed here.
      // A need can be open with no item behind it at all — "dinner" with no
      // restaurant chosen is the most common thing to want help with.
      const open = openNeeds(plan as never, plan.items as never);
      const emission = constraintsFromPlan(plan, { kind: input.needKind, open: open.includes(input.needKind) }, now);
      if (!emission.ok) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: refusalMessage(emission.reason) });
      }

      // One ask per need. A second live request for the same gap doubles what
      // every matching seller sees and makes two of them hold capacity for one
      // table.
      const already = await db.demand.findFirst({
        where: {
          planId: plan.id,
          category: emission.envelope.category,
          state: { in: LIVE_STATES },
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (already) {
        throw new TRPCError({ code: 'CONFLICT', message: 'You have already asked for that.' });
      }

      return raiseDemand(
        ctx.user.userId,
        emission.envelope,
        { planId: plan.id, budgetCents: input.budgetCents, note: input.note },
        now,
      );
    }),

  /**
   * What you asked for, and what came back.
   *
   * Without this a guest publishes into silence. The offers are included
   * because an answer nobody can see is the same as no answer, and only live
   * ones are: an expired hold is a seller's promise that has run out, and
   * showing it would be offering a table that is no longer held.
   */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const rows = await db.demand.findMany({
      where: {
        raisedByUserId: ctx.user.userId,
        OR: [
          { state: { in: LIVE_STATES }, expiresAt: { gt: now } },
          // A booking the guest accepted, until the table they hold has
          // finished. Dropping it the moment it is booked would make a
          // confirmed reservation vanish from the only screen that ever showed
          // it; dropping it at `startsAt` would do the same thing halfway
          // through the meal. Widened here by the maximum offer length and
          // narrowed to the exact end time below.
          {
            state: 'BOOKED',
            offers: { some: { state: 'ACCEPTED', startsAt: { gt: new Date(now.getTime() - MAX_OFFER_DURATION_MINS * 60_000) } } },
          },
        ],
      },
      orderBy: { raisedAt: 'desc' },
      take: 20,
      include: {
        offers: {
          // An accepted offer is the answer; the rest are history once one wins.
          where: { OR: [{ state: 'OFFERED', holdExpiresAt: { gt: now } }, { state: 'ACCEPTED' }] },
          orderBy: { startsAt: 'asc' },
          include: { location: { select: { label: true } } },
        },
      },
    });

    // The exact boundary the prefilter could not express. A booked demand whose
    // table has finished is history and stops being returned; a live one is
    // never dropped by this, because its own branch does not depend on offers.
    const current = rows.filter((row) => {
      if (row.state !== 'BOOKED') return true;
      return row.offers.some(
        (offer) => offer.state === 'ACCEPTED' && offer.startsAt.getTime() + offer.durationMins * 60_000 > now.getTime(),
      );
    });

    return current.map((row) => ({
      id: row.id,
      state: row.state,
      category: row.category,
      partySize: row.partySize,
      earliest: row.earliest.toISOString(),
      latest: row.latest.toISOString(),
      budgetCents: row.budgetCents ?? undefined,
      note: row.note ?? undefined,
      planId: row.planId ?? undefined,
      targetWindowId: row.targetWindowId ?? undefined,
      raisedAt: row.raisedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      offers: row.offers.map((offer) => ({
        id: offer.id,
        // The place, not the business: a guest recognises where they are going.
        where: offer.location.label,
        startsAt: offer.startsAt.toISOString(),
        durationMins: offer.durationMins,
        priceCents: offer.priceCents,
        terms: offer.terms ?? undefined,
        holdExpiresAt: offer.holdExpiresAt.toISOString(),
        // The client must be able to tell a table it holds from one it is being
        // shown, without inferring it from the demand's state.
        accepted: offer.state === 'ACCEPTED',
      })),
    }));
  }),

  /**
   * Take it back.
   *
   * A request that cannot be retracted is a promise a guest cannot get out of,
   * and it keeps occupying one of their five live slots until it expires.
   * Withdrawing releases the sellers who were holding capacity for it, so this
   * cancels outstanding offers in the same transaction rather than leaving
   * tables held for somebody who has gone elsewhere.
   */
  /**
   * Take the offer.
   *
   * The first point where the rail commits to anything. Everything before it
   * is conversation; this is a guest with a table and a seller with one fewer
   * to sell.
   */
  acceptOffer: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60 * 60 * 1000, max: 40, label: 'demand-accept' }))
    .input(z.object({ offerId: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await acceptOffer({ offerId: input.offerId, userId: ctx.user.userId });
      } catch (error) {
        // Gone and not-yours are both NOT_FOUND: a stranger probing offer ids
        // must not learn which ones exist.
        if (error instanceof OfferGone || error instanceof NotYours) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That offer is no longer available.' });
        }
        if (error instanceof OfferExpired) {
          throw new TRPCError({ code: 'CONFLICT', message: new OfferExpired().message });
        }
        if (error instanceof SlotTaken) {
          throw new TRPCError({ code: 'CONFLICT', message: new SlotTaken().message });
        }
        throw error;
      }
    }),

  withdraw: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60 * 60 * 1000, max: 40, label: 'demand-withdraw' }))
    .input(z.object({ demandId: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      // Scoped to the caller, so another person's request is indistinguishable
      // from one that does not exist.
      const demand = await db.demand.findFirst({
        where: { id: input.demandId, raisedByUserId: ctx.user.userId },
        select: { id: true, state: true },
      });
      if (!demand) throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found.' });

      // Already booked, expired or withdrawn. Terminal is terminal, and a
      // booked request is a commitment that is no longer the guest's alone.
      if (!LIVE_STATES.includes(demand.state)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That request has already finished.' });
      }

      const moved = await db.$transaction(async (tx) => {
        // Guarded on the state that was read, so a withdrawal racing a booking
        // cannot undo the booking.
        const changed = await tx.demand.updateMany({
          where: { id: demand.id, state: demand.state },
          data: { state: 'WITHDRAWN' },
        });
        if (changed.count === 0) return false;

        await tx.offer.updateMany({
          where: { demandId: demand.id, state: 'OFFERED' },
          data: { state: 'WITHDRAWN' },
        });
        await tx.demandEvent.create({ data: { demandId: demand.id, kind: 'WITHDRAWN' } });
        return true;
      });

      if (!moved) throw new TRPCError({ code: 'CONFLICT', message: 'That request has already finished.' });

      return { id: demand.id, state: 'WITHDRAWN' };
    }),
});
