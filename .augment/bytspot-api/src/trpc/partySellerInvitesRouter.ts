import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  InviteRefused, cancelHostInvite, createHostInvite, listHostInvites, searchInvitableSellers,
} from '../vendor/partySellerInvites';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const partyInput = z.object({ partyId: z.string().min(1).max(128) });

async function inviteResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof InviteRefused) throw new TRPCError({ code: error.reason, message: error.message });
    throw error;
  }
}

/** Register as events.sellerInvites. A host asks a business to sell on their Party. */
export const partySellerInvitesRouter = router({
  search: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'party-seller-search' }))
    .input(partyInput.extend({ query: z.string().max(80) }).strict())
    .query(({ ctx, input }) => inviteResult(() => searchInvitableSellers(ctx.user.userId, input.partyId, input.query))),

  list: protectedProcedure
    .input(partyInput.strict())
    .query(({ ctx, input }) => inviteResult(() => listHostInvites(ctx.user.userId, input.partyId))),

  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-seller-invite' }))
    .input(partyInput.extend({ sellerId: z.string().min(1).max(128), note: z.string().max(280).nullish() }).strict())
    .mutation(({ ctx, input }) => inviteResult(() => createHostInvite(ctx.user.userId, input))),

  cancel: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-seller-invite-cancel' }))
    .input(partyInput.extend({ inviteId: z.string().min(1).max(128) }).strict())
    .mutation(({ ctx, input }) => inviteResult(() => cancelHostInvite(ctx.user.userId, input))),
});
