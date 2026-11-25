import { z } from 'zod';
import { publicProcedure, rateLimitMiddleware, router } from './trpc';
import { HOME_BLOCKS, noteHomeTap } from '../services/homeTaps';

/** The app's Home screen. */
export const homeRouter = router({
  /** One tap on a Home block, counted for the admin Growth tab. Anonymous: a guest browses Home before signing in. */
  tap: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'home-tap' }))
    .input(z.object({ block: z.enum(HOME_BLOCKS) }).strict())
    .mutation(async ({ input }) => {
      await noteHomeTap(input.block);
      return { ok: true as const };
    }),
});
