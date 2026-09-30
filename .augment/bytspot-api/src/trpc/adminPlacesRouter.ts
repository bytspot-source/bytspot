/**
 * Admin Places: a Bytspot admin lists a Google place with its hand-checked
 * OpenTable or Resy link. The place becomes a discoverable venue, so guests
 * see the link, get directions and can check in for points, and every tap,
 * check-in and Plan add is counted for pitching the restaurant later.
 */
import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { assertBytspotAdmin, auditAdminAction } from '../services/adminRbac';
import {
  refreshTableBookingLinks,
  TABLE_BOOKING_PROVIDERS,
  tableBookingLinkFrom,
  tableBookingUrlError,
} from '../services/tableBookingLinks';
import { resolvePlaceCore, textSearchCore } from './placesRouter';
import { placeVenueSlug } from './partyRouter';

/** What a listed place is filed under. Each one maps to a Discover rail on web and iOS. */
export const LISTED_CATEGORIES = ['restaurant', 'bar', 'club', 'cafe'] as const;
export type ListedCategory = (typeof LISTED_CATEGORIES)[number];

const PLACE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const PITCH_WINDOW_DAYS = 30;

/** A starting guess from Google's type; the admin can change it before saving. */
export function categoryForPlaceType(primaryType: string | null | undefined): ListedCategory {
  const type = (primaryType ?? '').toLowerCase();
  if (type === 'night_club') return 'club';
  if (type.includes('cafe') || type.includes('coffee')) return 'cafe';
  if (type === 'bar' || type.endsWith('_bar') || type === 'pub' || type === 'wine_bar') return 'bar';
  return 'restaurant';
}

export type PitchCount = { total: number; last30: number };
export type PitchNumbers = { checkIns: PitchCount; bookingTaps: PitchCount; planAdds: PitchCount; bookedByGuests: PitchCount };

type Grouped = { key: string | null; count: number }[];

/** Folds all-time and last-30-day group counts into one card per place. */
export function pitchNumbersFor(
  venues: { id: string; googlePlaceId: string | null }[],
  counts: {
    checkIns: [Grouped, Grouped];
    bookingTaps: [Grouped, Grouped];
    planAdds: [Grouped, Grouped];
    bookedByGuests: [Grouped, Grouped];
  },
): Map<string, PitchNumbers> {
  const lookup = (groups: Grouped) => new Map(groups.filter((g) => g.key).map((g) => [g.key as string, g.count]));
  const pair = ([total, last30]: [Grouped, Grouped]) => ({ total: lookup(total), last30: lookup(last30) });
  const byVenue = { checkIns: pair(counts.checkIns), bookingTaps: pair(counts.bookingTaps) };
  const byPlace = { planAdds: pair(counts.planAdds), bookedByGuests: pair(counts.bookedByGuests) };
  const read = (maps: { total: Map<string, number>; last30: Map<string, number> }, key: string | null): PitchCount =>
    key ? { total: maps.total.get(key) ?? 0, last30: maps.last30.get(key) ?? 0 } : { total: 0, last30: 0 };
  return new Map(venues.map((venue) => [venue.id, {
    checkIns: read(byVenue.checkIns, venue.id),
    bookingTaps: read(byVenue.bookingTaps, venue.id),
    planAdds: read(byPlace.planAdds, venue.googlePlaceId),
    bookedByGuests: read(byPlace.bookedByGuests, venue.googlePlaceId),
  }]));
}

async function loadPitchNumbers(venues: { id: string; googlePlaceId: string | null }[], now: Date): Promise<Map<string, PitchNumbers>> {
  const since = new Date(now.getTime() - PITCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const venueIds = venues.map((v) => v.id);
  const placeIds = venues.map((v) => v.googlePlaceId).filter((id): id is string => Boolean(id));
  // Only a check-in made at the place counts: a self-reported tap from home
  // is not a guest Bytspot sent there.
  const checkIn = (after?: Date) => db.checkIn.groupBy({
    by: ['venueId'],
    where: { venueId: { in: venueIds }, proof: { not: 'self_reported' }, ...(after ? { createdAt: { gte: after } } : {}) },
    _count: { _all: true },
  }).then((rows) => rows.map((r) => ({ key: r.venueId, count: r._count._all })));
  const tap = (after?: Date) => db.bookingLinkTap.groupBy({
    by: ['venueId'],
    where: { venueId: { in: venueIds }, ...(after ? { createdAt: { gte: after } } : {}) },
    _count: { _all: true },
  }).then((rows) => rows.map((r) => ({ key: r.venueId, count: r._count._all })));
  const planItem = (booked: boolean, after?: Date) => db.planItem.groupBy({
    by: ['placeId'],
    where: {
      placeId: { in: placeIds },
      ...(booked ? { guestBookedAt: after ? { gte: after } : { not: null } } : after ? { createdAt: { gte: after } } : {}),
    },
    _count: { _all: true },
  }).then((rows) => rows.map((r) => ({ key: r.placeId, count: r._count._all })));

  const [c0, c30, t0, t30, p0, p30, b0, b30] = await Promise.all([
    checkIn(), checkIn(since), tap(), tap(since),
    planItem(false), planItem(false, since), planItem(true), planItem(true, since),
  ]);
  return pitchNumbersFor(venues, {
    checkIns: [c0, c30], bookingTaps: [t0, t30], planAdds: [p0, p30], bookedByGuests: [b0, b30],
  });
}

/** venues.list caches for 30 seconds; a change an admin just made should show now. */
async function forgetVenueLists(): Promise<void> {
  const redis = getRedis();
  if (redis) await redis.del('venues:all', 'venues:all:free', 'venues:all:paid').catch(() => undefined);
}

const listedSelect = {
  id: true, name: true, slug: true, address: true, category: true, googlePlaceId: true, discoverable: true,
  bookingProvider: true, bookingUrl: true, bookingCheckedAt: true, listedAt: true,
} satisfies Prisma.VenueSelect;

export const adminPlacesRouter = router({
  /** Google matches for a name, each marked when it is already listed. */
  search: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-places-search' }))
    .input(z.object({ query: z.string().trim().min(2).max(200) }))
    .query(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.places.search' });
      const found = await textSearchCore(input.query, 5);
      const placeIds = found.places.map((p) => p.placeId).filter(Boolean);
      const existing = await db.venue.findMany({
        where: { googlePlaceId: { in: placeIds } },
        select: { id: true, googlePlaceId: true, listedAt: true, discoverable: true },
      });
      const byPlace = new Map(existing.map((v) => [v.googlePlaceId, v]));
      return {
        source: found.source,
        places: found.places.map((p) => {
          const venue = byPlace.get(p.placeId);
          return {
            placeId: p.placeId, name: p.name, address: p.address, primaryType: p.primaryType,
            suggestedCategory: categoryForPlaceType(p.primaryType),
            listed: Boolean(venue?.listedAt && venue.discoverable),
            venueId: venue?.id ?? null,
          };
        }),
      };
    }),

  /** Every place an admin listed, with the numbers to show the restaurant. */
  list: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-places-list' }))
    .query(async ({ ctx }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.places.list' });
      const venues = await db.venue.findMany({
        where: { listedAt: { not: null } },
        select: listedSelect,
        orderBy: { listedAt: 'desc' },
        take: 500,
      });
      const numbers = await loadPitchNumbers(venues, new Date());
      return {
        pitchWindowDays: PITCH_WINDOW_DAYS,
        places: venues.map((v) => ({
          venueId: v.id, name: v.name, slug: v.slug, address: v.address, category: v.category,
          placeId: v.googlePlaceId, hidden: !v.discoverable,
          booking: tableBookingLinkFrom(v.bookingProvider, v.bookingUrl),
          checkedAt: v.bookingCheckedAt, listedAt: v.listedAt,
          numbers: numbers.get(v.id)!,
        })),
      };
    }),

  /**
   * Lists a place, or updates its link and category. The admin has opened the
   * link, so saving stamps today as its check date. Listing makes the venue
   * discoverable even if it already existed as a hidden Party arrival point.
   */
  save: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-places-save' }))
    .input(z.object({
      placeId: z.string().trim().regex(PLACE_ID),
      provider: z.enum(TABLE_BOOKING_PROVIDERS as [string, ...string[]]),
      url: z.string().trim().min(1).max(500),
      category: z.enum(LISTED_CATEGORIES),
    }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const problem = tableBookingUrlError(input.provider, input.url);
      if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem });
      const now = new Date();
      const listing = {
        discoverable: true, category: input.category,
        bookingProvider: input.provider, bookingUrl: input.url, bookingCheckedAt: now,
      };

      let venue = await db.venue.findUnique({ where: { googlePlaceId: input.placeId }, select: { id: true, listedAt: true } });
      if (!venue) {
        const place = await resolvePlaceCore(input.placeId);
        if (!place || !place.name || (place.lat === 0 && place.lng === 0)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Google could not find that place. Search again.' });
        }
        // Google may canonicalize the id; dedupe on what it actually returned.
        if (place.placeId !== input.placeId) {
          venue = await db.venue.findUnique({ where: { googlePlaceId: place.placeId }, select: { id: true, listedAt: true } });
        }
        for (let attempt = 0; !venue && attempt < 2; attempt++) {
          const slug = attempt === 0 ? placeVenueSlug(place.name, place.placeId) : `${placeVenueSlug(place.name, place.placeId)}-${randomBytes(3).toString('hex')}`;
          try {
            venue = await db.venue.create({
              data: {
                name: place.name, slug, googlePlaceId: place.placeId,
                address: place.address || place.name, lat: place.lat, lng: place.lng,
                ...listing, listedAt: now, listedByUserId: ctx.user.userId,
              },
              select: { id: true, listedAt: true },
            });
            // Match seed.ts: populate the PostGIS point so venues.nearby finds it.
            try {
              await db.$executeRawUnsafe('UPDATE "venues" SET "location" = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3', place.lng, place.lat, venue.id);
            } catch { /* PostGIS optional */ }
          } catch (err) {
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
            venue = await db.venue.findUnique({ where: { googlePlaceId: place.placeId }, select: { id: true, listedAt: true } });
          }
        }
        if (!venue) throw new TRPCError({ code: 'CONFLICT', message: 'That place could not be saved. Try again.' });
      }
      await db.venue.update({
        where: { id: venue.id },
        data: { ...listing, ...(venue.listedAt ? {} : { listedAt: now, listedByUserId: ctx.user.userId }) },
      });

      auditAdminAction({
        actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.places.save',
        detail: { venueId: venue.id, provider: input.provider },
      });
      await Promise.all([refreshTableBookingLinks(), forgetVenueLists()]);
      return { venueId: venue.id };
    }),

  /** Hides a listed place from guests, or shows it again. Its numbers are kept. */
  setHidden: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-places-hide' }))
    .input(z.object({ venueId: z.string().min(1).max(64), hidden: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      const updated = await db.venue.updateMany({
        where: { id: input.venueId, listedAt: { not: null } },
        data: { discoverable: !input.hidden },
      });
      if (updated.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'That place is not listed.' });
      auditAdminAction({
        actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.places.setHidden',
        detail: { venueId: input.venueId, hidden: input.hidden },
      });
      await Promise.all([refreshTableBookingLinks(), forgetVenueLists()]);
      return { hidden: input.hidden };
    }),
});
