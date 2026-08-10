import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../lib/db';
import { mobilityAggregatorReadiness } from '../services/mobilityAggregator';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const premiumMobilityTiers = new Set(['platinum', 'black']);
const handoffProviders = ['uber', 'lyft'] as const;
const coordinate = z.number().finite();
const pointInput = z.object({ lat: coordinate.min(-90).max(90), lng: coordinate.min(-180).max(180) });

const quoteInput = z.object({
  venueId: z.string().min(1).max(128),
  pickupLocation: pointInput,
  pickupLabel: z.string().trim().min(1).max(140).default('Current location'),
});

type HandoffProvider = typeof handoffProviders[number];
type HandoffDestination = { lat: number; lng: number; name: string; address: string };

function isPremiumMobilityTier(tier: string): boolean {
  return premiumMobilityTiers.has(tier);
}

async function requirePremiumMobilityMember(userId: string): Promise<'platinum' | 'black'> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { membershipTier: true } });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  if (!isPremiumMobilityTier(user.membershipTier)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Premium mobility is available to Black and Platinum members only.' });
  }
  return user.membershipTier as 'platinum' | 'black';
}

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002');
}

function handoffUrl(provider: HandoffProvider, destination: HandoffDestination): string {
  const formattedAddress = destination.address.trim() || destination.name;
  const url = new URL(provider === 'uber' ? 'https://m.uber.com/ul/' : 'https://ride.lyft.com/u');
  if (provider === 'uber') {
    url.searchParams.set('action', 'setPickup');
    url.searchParams.set('pickup', 'my_location');
    url.searchParams.set('dropoff[latitude]', String(destination.lat));
    url.searchParams.set('dropoff[longitude]', String(destination.lng));
    // Uber requires one of these labels for the destination pin to appear.
    url.searchParams.set('dropoff[nickname]', destination.name);
    url.searchParams.set('dropoff[formatted_address]', formattedAddress);
  } else {
    // Lyft's documented mobile-web handoff uses /u and a ride type id.
    url.searchParams.set('id', 'lyft');
    url.searchParams.set('destination[latitude]', String(destination.lat));
    url.searchParams.set('destination[longitude]', String(destination.lng));
  }
  return url.toString();
}

function quoteResponse(quote: {
  id: string; provider: string; providerQuoteId: string | null; serviceClass: string; serviceTitle: string;
  priceLabel: string | null; etaLabel: string | null; pickupLabel: string; dropoffLabel: string; expiresAt: Date;
  venue: HandoffDestination;
}) {
  return {
    id: quote.id,
    provider: quote.provider,
    providerQuoteId: quote.providerQuoteId,
    serviceClass: quote.serviceClass,
    serviceTitle: quote.serviceTitle,
    priceLabel: quote.priceLabel,
    etaLabel: quote.etaLabel,
    pickupLabel: quote.pickupLabel,
    dropoffLabel: quote.dropoffLabel,
    cancellationLabel: 'Cancel in the Uber or Lyft app after handoff.',
    providerBookingMode: 'handoff',
    requiresAccountLink: true,
    expiresAt: quote.expiresAt.toISOString(),
    aggregatorReadiness: mobilityAggregatorReadiness(),
    handoffOptions: handoffProviders.map((provider) => ({ provider, url: handoffUrl(provider, quote.venue) })),
  };
}

function tripResponse(trip: {
  id: string; quoteId: string; provider: string; providerReservationId: string | null; status: string;
  handoffUrl: string | null; createdAt: Date; updatedAt: Date;
  quote: { serviceClass: string; serviceTitle: string; priceLabel: string | null; etaLabel: string | null; pickupLabel: string; dropoffLabel: string };
}) {
  return {
    id: trip.id,
    quoteId: trip.quoteId,
    provider: trip.provider,
    providerReservationId: trip.providerReservationId,
    reservationReference: null,
    status: trip.status,
    serviceClass: trip.quote.serviceClass,
    serviceTitle: trip.quote.serviceTitle,
    priceLabel: trip.quote.priceLabel,
    etaLabel: trip.quote.etaLabel,
    pickupLabel: trip.quote.pickupLabel,
    dropoffLabel: trip.quote.dropoffLabel,
    handoffUrl: trip.handoffUrl,
    trackingUrl: null,
    trackingMode: 'handoff-only',
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

export const mobilityRouter = router({
  quotes: router({
    create: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'mobility-quote-create' }))
      .input(quoteInput)
      .mutation(async ({ ctx, input }) => {
        await requirePremiumMobilityMember(ctx.user.userId);
        const venue = await db.venue.findUnique({ where: { id: input.venueId }, select: { id: true, name: true, address: true, lat: true, lng: true } });
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Authorized mobility destination not found.' });

        const quote = await db.mobilityQuote.create({
          data: {
            userId: ctx.user.userId,
            venueId: venue.id,
            provider: 'handoff',
            serviceClass: 'premium',
            serviceTitle: 'Premium ride handoff',
            pickupLat: input.pickupLocation.lat,
            pickupLng: input.pickupLocation.lng,
            pickupLabel: input.pickupLabel,
            dropoffLabel: venue.address || venue.name,
            bookingMode: 'handoff',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          },
          include: { venue: { select: { lat: true, lng: true, name: true, address: true } } },
        });
        return quoteResponse(quote);
      }),
  }),

  reservations: router({
    create: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 6, label: 'mobility-handoff-create' }))
      .input(z.object({ quoteId: z.string().min(1), provider: z.enum(handoffProviders), idempotencyKey: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        await requirePremiumMobilityMember(ctx.user.userId);
        const existing = await db.mobilityTrip.findUnique({
          where: { userId_idempotencyKey: { userId: ctx.user.userId, idempotencyKey: input.idempotencyKey } },
          include: { quote: true },
        });
        if (existing) {
          if (existing.quoteId !== input.quoteId || existing.provider !== input.provider) {
            throw new TRPCError({ code: 'CONFLICT', message: 'This handoff retry does not match the original ride request.' });
          }
          return tripResponse(existing);
        }

        const quote = await db.mobilityQuote.findFirst({
          where: { id: input.quoteId, userId: ctx.user.userId, status: 'ready', expiresAt: { gt: new Date() } },
          include: { venue: { select: { lat: true, lng: true, name: true, address: true } } },
        });
        if (!quote) throw new TRPCError({ code: 'NOT_FOUND', message: 'This ride handoff has expired or is unavailable.' });
        if (quote.bookingMode !== 'handoff') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This provider booking mode is not enabled.' });

        try {
          const trip = await db.mobilityTrip.create({
            data: {
              userId: ctx.user.userId,
              quoteId: quote.id,
              idempotencyKey: input.idempotencyKey,
              provider: input.provider,
              handoffUrl: handoffUrl(input.provider, quote.venue),
              status: 'handoff_pending',
            },
            include: { quote: true },
          });
          return tripResponse(trip);
        } catch (error) {
          if (!isUniqueConstraint(error)) throw error;
          const raced = await db.mobilityTrip.findFirst({ where: { quoteId: quote.id, userId: ctx.user.userId }, include: { quote: true } });
          if (raced && raced.provider === input.provider) return tripResponse(raced);
          throw new TRPCError({ code: 'CONFLICT', message: 'A different provider handoff already exists for this quote.' });
        }
      }),

    cancel: protectedProcedure
      .input(z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(240).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requirePremiumMobilityMember(ctx.user.userId);
        const updated = await db.mobilityTrip.updateMany({
          where: { id: input.id, userId: ctx.user.userId, status: 'handoff_pending' },
          data: { status: 'cancelled', cancellationReason: input.reason ?? null },
        });
        if (updated.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Active ride handoff not found.' });
        return { ok: true, success: true, cancellationMode: 'handoff-only' as const };
      }),
  }),

  trips: router({
    status: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        await requirePremiumMobilityMember(ctx.user.userId);
        const trip = await db.mobilityTrip.findFirst({ where: { id: input.id, userId: ctx.user.userId }, include: { quote: true } });
        if (!trip) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ride handoff not found.' });
        return tripResponse(trip);
      }),
  }),
});

export { handoffUrl, isPremiumMobilityTier };