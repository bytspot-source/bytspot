import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router } from './trpc';
import { guestTicket, myTickets, PaymentsUnavailable, startTicketCheckout, TicketRefused } from '../vendor/tickets';

/** A business's own dated tickets, as guests open, buy and hold them. */
export const ticketsRouter = router({
  get: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'tickets-get' }))
    .input(z.object({ ticketId: z.string().trim().min(1).max(64) }))
    .query(async ({ input }) => {
      const ticket = await guestTicket(input.ticketId);
      if (!ticket) throw new TRPCError({ code: 'NOT_FOUND', message: 'This ticket is not available.' });
      return ticket;
    }),

  /** A hosted checkout URL. The ticket is counted when the payment is confirmed, and refunded if it is gone by then. */
  checkout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60 * 60 * 1000, max: 40, label: 'tickets-checkout' }))
    .input(z.object({ ticketId: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await startTicketCheckout({ ticketId: input.ticketId, userId: ctx.user.userId });
      } catch (error) {
        if (error instanceof TicketRefused) {
          throw new TRPCError({ code: error.status === 404 ? 'NOT_FOUND' : 'CONFLICT', message: error.blockers[0] });
        }
        if (error instanceof PaymentsUnavailable) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message });
        throw error;
      }
    }),

  mine: protectedProcedure.query(({ ctx }) => myTickets(ctx.user.userId)),
});
