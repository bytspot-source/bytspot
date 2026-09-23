import { inventoryInput, liveInventory } from '../vendor/inventory';
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
});
