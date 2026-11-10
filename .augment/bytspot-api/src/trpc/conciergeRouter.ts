import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { conciergeDiscoverInput, conciergeDiscoverOutput } from '../services/conciergeDiscovery';
import { discoverConcierge, identifyConciergeDish } from '../services/conciergeDiscoveryAdapters';
import { conciergeIdentifyDishInput, conciergeIdentifyDishOutput } from '../services/conciergeDishPhoto';
import { config } from '../config';
import { CONCIERGE_REFUSAL_TEXT, conciergeRefusal, onConciergePilot } from '../services/conciergeAccess';

/** During the pilot only listed user ids reach discovery; everyone else gets the same not-enabled reply. */
export function conciergeOpenTo(userId: string | undefined): boolean {
  return config.conciergeDiscoveryEnabled && onConciergePilot(userId);
}

/** Separate from legacy chat: no client-provided venues, model prose or supply. */
export const conciergeDiscoveryRouter = router({
  discover: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'concierge-discover' }))
    .input(conciergeDiscoverInput)
    .output(conciergeDiscoverOutput)
    .mutation(({ ctx, input }) => {
      if (!conciergeOpenTo(ctx.user.userId)) return {
        version: 1 as const, status: 'unavailable' as const,
        reply: 'Concierge discovery is not enabled yet. You can browse places in Discover.',
        cards: [], refinements: [],
      };
      return discoverConcierge(input);
    }),

  /** Suggests dish names only. The photo is not stored; the guest confirms a name before any search. */
  identifyDish: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 6, label: 'concierge-identify-dish' }))
    .use(rateLimitMiddleware({ windowMs: 86_400_000, max: 40, label: 'concierge-identify-dish-daily' }))
    .input(conciergeIdentifyDishInput)
    .output(conciergeIdentifyDishOutput)
    .mutation(async ({ ctx, input }) => {
      if (!conciergeOpenTo(ctx.user.userId) || !config.conciergePhotoEnabled) return {
        version: 1 as const, status: 'unavailable' as const,
        reply: 'Photo search is not enabled yet. Type the dish name to search nearby.', candidates: [],
      };
      // REA C3: the photo goes to an AI provider.
      const refusal = await conciergeRefusal(ctx.user.userId);
      if (refusal) return { version: 1 as const, status: 'unavailable' as const, reply: CONCIERGE_REFUSAL_TEXT[refusal], candidates: [] };
      return identifyConciergeDish(input);
    }),
});
