import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../lib/db';
import { publicProcedure, rateLimitMiddleware, router } from './trpc';
import { loadPitchNumbers, type PitchNumbers } from './adminPlacesRouter';
import { readPitchCode } from '../services/pitchLink';
import { venueControl } from '../services/venueControl';
import { currentPlatformFeeBps, VENDOR_BOOKING_FEE_SCOPE } from '../services/platformFee';
import { config } from '../config';
import { sendVendorLeadEmail, type VendorLeadNotice } from '../lib/email';
import { captureError } from '../lib/observability';

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

export const joinRequestInput = z.object({
  code: z.string().min(1).max(400),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(40).optional(),
}).strict();

export interface JoinRequestDependencies {
  venue: PitchDependencies['venue'];
  inbox: string;
  send(to: string, lead: VendorLeadNotice): Promise<void>;
}

const joinDefaults: JoinRequestDependencies = { venue: defaults.venue, inbox: config.vendorLeadEmail, send: sendVendorLeadEmail };

/**
 * The pitch page's "Join" asks Bytspot for an invite: there is no self sign-up,
 * so a business that signs in uninvited has no seat. False: the link is bad,
 * expired, or the place already joined.
 */
export async function requestJoin(input: z.infer<typeof joinRequestInput>, deps: JoinRequestDependencies = joinDefaults, now = new Date()): Promise<boolean> {
  const venueId = readPitchCode(input.code, now);
  if (!venueId) return false;
  const venue = await deps.venue(venueId);
  if (!venue || venueControl(venue) === 'bytspot') return false;
  if (!deps.inbox) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Bytspot cannot take requests here right now. Email Bytspot instead.' });
  await deps.send(deps.inbox, {
    placeName: venue.name, placeAddress: venue.address,
    contactName: input.name, contactEmail: input.email, contactPhone: input.phone || null,
  });
  return true;
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

  requestJoin: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60 * 60_000, max: 5, label: 'pitch-join' }))
    .input(joinRequestInput)
    .mutation(async ({ input }) => {
      let sent: boolean;
      try {
        sent = await requestJoin(input);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        captureError(error, { route: 'pitch.requestJoin' });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Your request did not send. Try again in a minute.' });
      }
      if (!sent) throw new TRPCError({ code: 'NOT_FOUND', message: 'This link has expired or is no longer available.' });
      return { sent: true as const };
    }),
});
