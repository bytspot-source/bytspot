import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createPaymentSetupSession,
  listSavedPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod,
} from '../services/savedPaymentMethods';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const methodInput = z.object({ paymentMethodId: z.string().trim().min(1).max(255) });
const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'That card is not saved on this account.' });

/**
 * Saved cards. Stripe hosts the card form; the return path is fixed by the
 * server, so the paths the app sends are accepted and not used.
 */
export const paymentsRouter = router({
  listMethods: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'payments-list' }))
    .query(({ ctx }) => listSavedPaymentMethods(ctx.user.userId)),

  setupSession: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'payments-setup' }))
    .input(z.object({ successPath: z.string().max(200).optional(), cancelPath: z.string().max(200).optional() }).optional())
    .mutation(async ({ ctx }) => {
      const session = await createPaymentSetupSession(ctx.user.userId);
      if (!session) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Saved cards are not available right now.' });
      return session;
    }),

  setDefaultMethod: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'payments-default' }))
    .input(methodInput)
    .mutation(async ({ ctx, input }) => {
      if (!(await setDefaultPaymentMethod(ctx.user.userId, input.paymentMethodId))) throw notFound();
      return { ok: true as const };
    }),

  removeMethod: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'payments-remove' }))
    .input(methodInput)
    .mutation(async ({ ctx, input }) => {
      if (!(await removePaymentMethod(ctx.user.userId, input.paymentMethodId))) throw notFound();
      return { ok: true as const };
    }),
});
