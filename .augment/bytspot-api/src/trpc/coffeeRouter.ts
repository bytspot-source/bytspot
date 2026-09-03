import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { publicProcedure, protectedProcedure, rateLimitMiddleware, router } from './trpc';

/**
 * Coffee — Phase 2's second real bookable.
 *
 * A CoffeeSpot is a table Bytspot can hold; a CoffeeReservation is a caller's
 * ask for that hold. Both live server-side: the client never states the hold
 * window, the reservation status, or the capability. `capability` on a Plan
 * item pointing to a reservation is always `request` — a hold ask, not a
 * payment. Money is not a Phase 2 surface.
 */

/** Public listing is bounded by proximity or, without coordinates, by age. */
const LIST_MAX_TAKE = 50;
const LIST_DEFAULT_RADIUS_KM = 25;
/** A reservation for something more than a month out is a booking, not a hold. */
const MAX_RESERVATION_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** Two hours: a fresh request against the same spot inside this window is a
 *  refresh of the last one, not a second hold. */
const DOUBLE_REQUEST_COOLDOWN_MS = 2 * 60 * 60 * 1000;

type ReservationStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'expired';

export const coffeeRouter = router({
  /**
   * Public: only active spots, only fields a card can render. Owner is never
   * returned — the router does not surface vendor identity here.
   */
  list: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'coffee-list' }))
    .input(
      z
        .object({
          near: z
            .object({
              latitude: z.number().min(-90).max(90),
              longitude: z.number().min(-180).max(180),
              radiusKm: z.number().positive().max(200).default(LIST_DEFAULT_RADIUS_KM),
            })
            .optional(),
        })
        .default({}),
    )
    .query(async ({ input }) => {
      const spots = await db.coffeeSpot.findMany({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
        take: LIST_MAX_TAKE,
        select: { id: true, name: true, areaLabel: true, latitude: true, longitude: true, holdMinutes: true },
      });
      const ranked = input.near
        ? spots
            .map((spot) => ({ spot, km: haversineKm(input.near!, spot) }))
            .filter((row) => row.km !== null && row.km <= input.near!.radiusKm)
            .sort((a, b) => (a.km! - b.km!))
            .map((row) => row.spot)
        : spots;
      return {
        spots: ranked.map((spot) => ({
          id: spot.id,
          name: spot.name,
          areaLabel: spot.areaLabel,
          holdMinutes: spot.holdMinutes,
        })),
      };
    }),

  reservations: router({
    /**
     * A caller asks for a hold. The server, not the client, computes the hold
     * window, refuses spots that are inactive or requests for more than the
     * horizon, and enforces a per-spot cooldown so a bounce cannot turn into
     * two concurrent holds against the same table.
     */
    create: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'coffee-reservation-create' }))
      .input(
        z.object({
          coffeeSpotId: z.string().min(1),
          idempotencyKey: z.string().uuid(),
          partySize: z.number().int().min(1).max(8),
          requestedFor: z.coerce.date(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const now = new Date();
        if (input.requestedFor.getTime() < now.getTime() - 60_000) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'That time has already passed.' });
        }
        if (input.requestedFor.getTime() - now.getTime() > MAX_RESERVATION_HORIZON_MS) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is too far out for a hold.' });
        }

        const idempotencyKey = { requestedByUserId_idempotencyKey: { requestedByUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } };
        const existing = await db.coffeeReservation.findUnique({ where: idempotencyKey });
        if (existing) return serializeReservation(existing);

        const spot = await db.coffeeSpot.findFirst({
          where: { id: input.coffeeSpotId, active: true },
          select: { id: true, holdMinutes: true },
        });
        if (!spot) throw new TRPCError({ code: 'NOT_FOUND', message: 'That coffee spot is not available.' });

        // Same caller, same spot, still in a live hold: the second request is a
        // duplicate. It is refused rather than silently returning the first,
        // because two idempotency keys are two different intents and combining
        // them would hide a bug.
        const cooldownStart = new Date(now.getTime() - DOUBLE_REQUEST_COOLDOWN_MS);
        const openOnSameSpot = await db.coffeeReservation.findFirst({
          where: {
            requestedByUserId: ctx.user.userId,
            coffeeSpotId: spot.id,
            status: { in: ['pending', 'confirmed'] as const },
            createdAt: { gte: cooldownStart },
          },
          select: { id: true },
        });
        if (openOnSameSpot) {
          throw new TRPCError({ code: 'CONFLICT', message: 'You already have a live hold on this spot.' });
        }

        try {
          const created = await db.coffeeReservation.create({
            data: {
              coffeeSpotId: spot.id,
              requestedByUserId: ctx.user.userId,
              idempotencyKey: input.idempotencyKey,
              partySize: input.partySize,
              requestedFor: input.requestedFor,
              holdExpiresAt: new Date(now.getTime() + spot.holdMinutes * 60_000),
            },
          });
          return serializeReservation(created);
        } catch (error) {
          // A racing retry landed the same idempotency key first. Return the
          // one that won; the caller gets the same reservation either way.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const concurrent = await db.coffeeReservation.findUnique({ where: idempotencyKey });
            if (concurrent) return serializeReservation(concurrent);
          }
          throw error;
        }
      }),

    /**
     * Only the requester cancels. A reservation already `declined`,
     * `cancelled`, or `expired` is terminal — cancel is idempotent on those
     * to keep clients simple. If the reservation is attached to a Plan item,
     * the item is cancelled in the same write so the two never disagree.
     */
    cancel: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'coffee-reservation-cancel' }))
      .input(z.object({ reservationId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const reservation = await db.coffeeReservation.findUnique({
          where: { id: input.reservationId },
          select: { id: true, requestedByUserId: true, status: true, planItem: { select: { id: true } } },
        });
        // Not-found and not-yours read the same, because leaking existence to
        // a stranger is what the party invariant is under too.
        if (!reservation || reservation.requestedByUserId !== ctx.user.userId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That reservation could not be found.' });
        }
        // Idempotent on terminal states; the client does not need to know
        // which terminal state won.
        if (reservation.status === 'declined' || reservation.status === 'cancelled' || reservation.status === 'expired') {
          return { status: reservation.status as ReservationStatus };
        }

        const now = new Date();
        await db.$transaction(async (tx) => {
          await tx.coffeeReservation.update({
            where: { id: reservation.id },
            data: { status: 'cancelled', decidedAt: now },
          });
          if (reservation.planItem) {
            // Item history is never rewritten; a cancelled reservation cancels
            // the item it filled, so the Plan cannot keep advertising it.
            await tx.planItem.updateMany({
              where: { id: reservation.planItem.id, status: { not: 'booked' } },
              data: { status: 'cancelled' },
            });
          }
        });
        return { status: 'cancelled' as const };
      }),
  }),
});

/** What a caller reads back. Owner and hold internals stay server-side. */
function serializeReservation(reservation: {
  id: string;
  status: string;
  holdExpiresAt: Date;
  requestedFor: Date;
  partySize: number;
  coffeeSpotId: string;
}) {
  return {
    id: reservation.id,
    coffeeSpotId: reservation.coffeeSpotId,
    status: reservation.status as ReservationStatus,
    holdExpiresAt: reservation.holdExpiresAt,
    requestedFor: reservation.requestedFor,
    partySize: reservation.partySize,
  };
}

/** Great-circle distance in km. Null when either row lacks coordinates. */
function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number | null; longitude: number | null }): number | null {
  if (b.latitude === null || b.longitude === null) return null;
  const R = 6371;
  const dLat = deg(b.latitude - a.latitude);
  const dLon = deg(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg(a.latitude)) * Math.cos(deg(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function deg(value: number): number {
  return (value * Math.PI) / 180;
}
