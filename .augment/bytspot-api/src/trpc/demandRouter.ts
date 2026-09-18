import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { DEMAND_DEFAULTS, demandCategoryIds } from '../vendor/demand';

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

      const live = await db.demand.count({
        where: { raisedByUserId: ctx.user.userId, state: { in: ['OPEN', 'MATCHED', 'OFFERED'] }, expiresAt: { gt: now } },
      });
      if (live >= MAX_LIVE_PER_USER) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You have too many open requests. Let one land or expire first.',
        });
      }

      // A demand must not outlive the window it asks about. The contract's
      // expiry is the longest anyone waits; a request for dinner tonight stops
      // being a request the moment tonight is over.
      const contractExpiry = new Date(now.getTime() + DEMAND_DEFAULTS.expiryMins * 60_000);
      const expiresAt = contractExpiry < input.latest ? contractExpiry : input.latest;

      const demand = await db.demand.create({
        data: {
          planId: input.planId ?? null,
          raisedByUserId: ctx.user.userId,
          category: input.category,
          partySize: input.partySize,
          earliest: input.earliest,
          latest: input.latest,
          latitude: input.latitude,
          longitude: input.longitude,
          radiusMiles: input.radiusMiles ?? DEMAND_DEFAULTS.radiusMiles,
          budgetCents: input.budgetCents ?? null,
          note: input.note || null,
          expiresAt,
        },
      });

      await db.demandEvent.create({ data: { demandId: demand.id, kind: 'RAISED' } });

      return {
        id: demand.id,
        state: demand.state,
        category: demand.category,
        expiresAt: demand.expiresAt.toISOString(),
        raisedAt: demand.raisedAt.toISOString(),
      };
    }),
});
