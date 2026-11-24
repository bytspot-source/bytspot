import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { inventoryInput, inventoryTypesInput, liveCard, liveCardsAtVenue, liveInventory, liveRequestTypes, venueInventoryInput } from '../vendor/inventory';
import { openPatch } from '../vendor/patches';
import { publicProcedure, rateLimitMiddleware, router } from './trpc';

/**
 * Published vendor windows near a point, as Discover cards. Public because
 * Discover renders before sign-in; everything returned is already public.
 */
export const inventoryRouter = router({
  list: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'inventory-list' }))
    .input(inventoryInput)
    .query(({ input }) => liveInventory(input)),

  /** Which kinds of Bytspot business take requests near a point, for a Plan's Request a booking. */
  types: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'inventory-types' }))
    .input(inventoryTypesInput)
    .query(async ({ input }) => ({ types: await liveRequestTypes(input) })),

  /** One offering, so a guest can change a request they sent it. */
  window: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'inventory-window' }))
    .input(z.object({ windowId: z.string().trim().min(1).max(64) }))
    .query(async ({ input }) => {
      const card = await liveCard(input.windowId);
      if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'This is no longer taking requests.' });
      return card;
    }),

  /** What the businesses attached to one listed place offer, for its detail page. */
  atVenue: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'inventory-at-venue' }))
    .input(venueInventoryInput)
    .query(({ input }) => liveCardsAtVenue(input)),

  /**
   * A scanned QR / NFC patch: the place it names and what can be asked for
   * there. A mutation because every open is counted on the patch.
   */
  openPatch: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'inventory-open-patch' }))
    .input(z.object({ code: z.string().trim().min(1).max(40) }))
    .mutation(async ({ input }) => {
      const opened = await openPatch(input.code);
      if (!opened) throw new TRPCError({ code: 'NOT_FOUND', message: 'This code is not in use.' });
      return opened;
    }),
});
