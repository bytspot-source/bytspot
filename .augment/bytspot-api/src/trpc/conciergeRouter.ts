import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { conciergeDiscoverInput, conciergeDiscoverOutput } from '../services/conciergeDiscovery';
import { discoverConcierge } from '../services/conciergeDiscoveryAdapters';
import { config } from '../config';

/** Separate from legacy chat: no client-provided venues, model prose or supply. */
export const conciergeDiscoveryRouter = router({
  discover: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'concierge-discover' }))
    .input(conciergeDiscoverInput)
    .output(conciergeDiscoverOutput)
    .mutation(({ input }) => {
      if (!config.conciergeDiscoveryEnabled) return {
        version: 1 as const, status: 'unavailable' as const,
        reply: 'Concierge discovery is not enabled yet. You can browse places in Discover.',
        cards: [], refinements: [],
      };
      return discoverConcierge(input);
    }),
});
