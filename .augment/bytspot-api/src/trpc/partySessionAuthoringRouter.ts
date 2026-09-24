import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../lib/db';
import { effectiveCapabilities, roleScope, sellerRequirements } from '../vendor/contract';
import { outstandingRequirements } from '../vendor/sellerState';
import {
  authorSessionInput, authorPartySession, listPartySessions, withdrawPartySession,
  SessionInUse, SessionPartyNotFound, SessionRefused,
} from '../vendor/partySessions';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const partyInput = z.object({ partyId: z.string().min(1).max(128) });
const sellerInput = partyInput.extend({ sellerId: z.string().min(1).max(128).optional() });
const noSeatReason = 'An active seller seat is required. Ask the existing seller owner to arrange your access. Seller registration and seat activation are not available in this native sheet.';

/** Ownership is checked before revealing any seller/setup information. */
async function authoringAccess(userId: string, partyId: string) {
  const party = await db.party.findFirst({
    where: { id: partyId, hostUserId: userId, status: { not: 'cancelled' } },
    select: { id: true },
  });
  if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
  const seats = await db.vendorSeat.findMany({
    where: { userId, state: 'ACTIVE' },
    include: { seller: { include: { locations: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const sellers = seats.map((seat) => {
    const capabilities = effectiveCapabilities(seat.role, seat.seller.state);
    let reason: string | null = null;
    if (!capabilities.includes('SELL') || roleScope(seat.role) !== 'all') {
      reason = 'This seller seat cannot sell sessions. Ask the seller owner to review your role and the business approval or suspension status in the vendor console.';
    } else {
      // ACTIVE is not sufficient: payout or location requirements can lapse.
      const missing = outstandingRequirements(seat.seller, seat.seller.locations);
      if (missing.length) {
        const labels = sellerRequirements().filter((entry) => missing.includes(entry.id)).map((entry) => entry.label);
        reason = `Seller setup needs attention: ${labels.join(', ')}. Ask the seller owner to resolve this in the existing vendor console; setup is not available in this native sheet.`;
      }
    }
    return { id: seat.sellerId, name: seat.seller.legalName?.trim() || 'Unnamed business', canAuthor: reason === null, reason };
  });
  return { sellers, reason: sellers.length ? null : noSeatReason };
}

async function authorizedSeller(userId: string, input: z.infer<typeof sellerInput>) {
  const access = await authoringAccess(userId, input.partyId);
  if (!access.sellers.length) throw new TRPCError({ code: 'FORBIDDEN', message: noSeatReason });
  if (!input.sellerId && access.sellers.length > 1) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose the seller business for these sessions.' });
  }
  const seller = input.sellerId ? access.sellers.find((entry) => entry.id === input.sellerId) : access.sellers[0];
  if (!seller) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
  if (!seller.canAuthor) throw new TRPCError({ code: 'FORBIDDEN', message: seller.reason! });
  return seller.id;
}

async function serviceResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof SessionPartyNotFound) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party or session not found.' });
    if (error instanceof SessionRefused) throw new TRPCError({ code: 'BAD_REQUEST', message: error.issues.map((issue) => `${issue.field}: ${issue.message}`).join('\n') });
    if (error instanceof SessionInUse) throw new TRPCError({ code: 'CONFLICT', message: error.blockers.join('\n') });
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Session request could not be completed. Refresh the list before trying again.', cause: error });
  }
}

/** Register as events.sessionAuthoring; preserve the legacy events.sessions list.
 * No provisioning, settlement or transfer writes. */
export const partySessionAuthoringRouter = router({
  access: protectedProcedure.input(partyInput.strict()).query(({ ctx, input }) => authoringAccess(ctx.user.userId, input.partyId)),

  list: protectedProcedure.input(sellerInput.strict()).query(async ({ ctx, input }) => {
    const sellerId = await authorizedSeller(ctx.user.userId, input);
    return { sessions: await serviceResult(() => listPartySessions(sellerId, input.partyId)) };
  }),

  // The name is reserved for the native contract; the service is CREATE ONLY.
  // Reject an edit explicitly rather than accidentally minting another unit.
  upsert: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-session-author' }))
    .input(sellerInput.extend({
      sessionId: z.string().min(1).max(128).optional(),
      session: authorSessionInput.extend({
        // JSON transport carries ISO strings; the shared service receives Dates.
        startsAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
        endsAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
        priceCents: z.number().int().min(1, 'Free sessions are not supported by this authoring flow.').max(10_000_000),
      }).strict(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const sellerId = await authorizedSeller(ctx.user.userId, input);
      if (input.sessionId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Editing an existing session is not supported. Withdraw it when eligible, then create a replacement.' });
      return serviceResult(() => authorPartySession(sellerId, input.partyId, input.session));
    }),

  withdraw: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-session-withdraw' }))
    .input(sellerInput.extend({ sessionId: z.string().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      const sellerId = await authorizedSeller(ctx.user.userId, input);
      // The vendor service takes only a session ID. Bind it to this host's
      // requested party first; a seat alone cannot withdraw another host's row.
      const session = await db.partySession.findFirst({
        where: { id: input.sessionId, partyId: input.partyId, sellerId, withdrawnAt: null },
        select: { id: true },
      });
      if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party or session not found.' });
      await serviceResult(() => withdrawPartySession(sellerId, session.id));
      return { withdrawn: true as const };
    }),
});
