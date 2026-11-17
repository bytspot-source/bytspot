import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../lib/db';
import { publicProcedure, rateLimitMiddleware, router } from './trpc';
import { loadPitchNumbers, type PitchNumbers } from './adminPlacesRouter';
import { readPitchCode } from '../services/pitchLink';
import { venueControl } from '../services/venueControl';
import { currentPlatformFeeBps, VENDOR_BOOKING_FEE_SCOPE } from '../services/platformFee';

export interface PitchView {
  name: string;
  address: string;
  numbers: PitchNumbers;
  /** What Bytspot keeps from a booking made in Bytspot, in percent. */
  bookingFeePercent: number;
  joinUrl: string;
}

export interface PitchDependencies {
  venue(id: string): Promise<{ id: string; name: string; address: string; googlePlaceId: string | null; controlledAt: Date | null } | null>;
  numbers(venue: { id: string; googlePlaceId: string | null }): Promise<PitchNumbers>;
  feeBps(): Promise<number>;
}

export const VENDOR_JOIN_URL = 'https://vendor.bytspot.app/';

const defaults: PitchDependencies = {
  venue: (id) => db.venue.findFirst({
    where: { id, listedAt: { not: null }, discoverable: true },
    select: { id: true, name: true, address: true, googlePlaceId: true, controlledAt: true },
  }),
  numbers: async (venue) => (await loadPitchNumbers([venue], new Date())).get(venue.id)!,
  feeBps: () => currentPlatformFeeBps(VENDOR_BOOKING_FEE_SCOPE),
};

/** The public page behind a pitch link. A bad, expired or already-joined link reads as not found. */
export async function pitchView(code: string, deps: PitchDependencies = defaults, now = new Date()): Promise<PitchView | null> {
  const venueId = readPitchCode(code, now);
  if (!venueId) return null;
  const venue = await deps.venue(venueId);
  if (!venue || venueControl(venue) === 'bytspot') return null;
  const [numbers, feeBps] = await Promise.all([deps.numbers(venue), deps.feeBps()]);
  return { name: venue.name, address: venue.address, numbers, bookingFeePercent: feeBps / 100, joinUrl: VENDOR_JOIN_URL };
}

export const pitchRouter = router({
  view: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'pitch-view' }))
    .input(z.object({ code: z.string().min(1).max(400) }))
    .query(async ({ input }) => {
      const view = await pitchView(input.code);
      if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'This link has expired or is no longer available.' });
      return view;
    }),
});
