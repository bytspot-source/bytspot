import { z } from 'zod';
import { db } from '../lib/db';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

// A receipt is not admission. No credentials, checkout URLs, payment-provider
// identifiers, seller payouts or private locations leave this read-only router.
const partySelect = {
  id: true, title: true, startsAt: true, endsAt: true, closedAt: true,
} as const;
const sessionSelect = {
  id: true, name: true, startsAt: true, endsAt: true,
  bottleCount: true, bottleTerms: true, withdrawnAt: true,
} as const;

type PartySummary = {
  id: string; title: string; startsAt: Date; endsAt: Date | null; closedAt: Date | null;
};
function partyView(party: PartySummary, now: Date) {
  return {
    id: party.id, title: party.title, startsAt: party.startsAt.toISOString(),
    endsAt: party.endsAt?.toISOString() ?? null,
    isPast: (party.endsAt?.getTime() ?? party.startsAt.getTime() + 6 * 60 * 60 * 1000) <= now.getTime(),
    closed: party.closedAt !== null,
  };
}
type SessionSummary = {
  id: string; name: string; startsAt: Date; endsAt: Date;
  bottleCount: number; bottleTerms: string; withdrawnAt: Date | null;
};
function sessionView(session: SessionSummary) {
  return {
    id: session.id, name: session.name, startsAt: session.startsAt.toISOString(),
    endsAt: session.endsAt.toISOString(), bottleCount: session.bottleCount,
    bottleTerms: session.bottleTerms, withdrawn: session.withdrawnAt !== null,
  };
}

/** Register as events.commerce. Independent keyset pages cannot hide purchases
 * behind a full page of passes (or vice versa). An id cursor is a bound, never
 * an unscoped lookup; every page still predicates on the authenticated user. */
export const partyCommerceRouter = router({
  mine: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'party-commerce-mine' }))
    .input(z.object({
      kind: z.enum(['passes', 'purchases', 'claims']).default('passes'),
      cursor: z.string().min(1).max(128).optional(),
      partyId: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(50).default(25),
    }).strict().optional().default({}))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const page = {
        orderBy: { id: 'desc' as const }, take: input.limit + 1,
      };
      const scope = {
        userId: ctx.user.userId,
        ...(input.partyId ? { partyId: input.partyId } : {}),
        ...(input.cursor ? { id: { lt: input.cursor } } : {}),
      };
      if (input.kind === 'passes') {
        const rows = await db.partyGuest.findMany({
          ...page,
          where: { ...scope, accessGranted: true, party: { status: 'published' } },
          select: { id: true, status: true, accessGranted: true, ticketTierName: true, checkedInAt: true, party: { select: partySelect } },
        });
        const kept = rows.slice(0, input.limit);
        return {
          kind: 'passes' as const,
          passes: kept.map((row) => ({
            id: row.id, status: row.status, accessGranted: row.accessGranted,
            ticketTierName: row.ticketTierName, checkedInAt: row.checkedInAt?.toISOString() ?? null,
            party: partyView(row.party, now),
          })),
          nextCursor: rows.length > input.limit ? kept[kept.length - 1].id : null,
        };
      }
      if (input.kind === 'purchases') {
        // Include expired and refund-required rows, not just successful charges.
        // Status is the settlement record verbatim; a return URL proves nothing.
        const rows = await db.partyCheckout.findMany({
          ...page, where: scope,
          select: {
            id: true, status: true, idempotencyKey: true, ticketTierName: true, amountCents: true,
            sessionAmountCents: true, currency: true, reservationExpiresAt: true,
            completedAt: true, createdAt: true, party: { select: partySelect },
            session: { select: sessionSelect },
          },
        });
        const kept = rows.slice(0, input.limit);
        return {
          kind: 'purchases' as const,
          purchases: kept.map((row) => ({
            id: row.id, status: row.status, retryKey: row.idempotencyKey, ticketTierName: row.ticketTierName,
            amountCents: row.amountCents, sessionAmountCents: row.sessionAmountCents,
            currency: row.currency, reservationExpiresAt: row.reservationExpiresAt.toISOString(),
            reservationElapsed: row.reservationExpiresAt <= now,
            completedAt: row.completedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
            party: partyView(row.party, now), session: row.session ? sessionView(row.session) : null,
          })),
          nextCursor: rows.length > input.limit ? kept[kept.length - 1].id : null,
        };
      }
      const rows = await db.partySessionClaim.findMany({
        ...page, where: scope,
        select: { id: true, state: true, createdAt: true, session: { select: { ...sessionSelect, party: { select: partySelect } } } },
      });
      const kept = rows.slice(0, input.limit);
      return {
        kind: 'claims' as const,
        claims: kept.map((row) => ({
          id: row.id, state: row.state, createdAt: row.createdAt.toISOString(),
          party: partyView(row.session.party, now), session: sessionView(row.session),
        })),
        nextCursor: rows.length > input.limit ? kept[kept.length - 1].id : null,
      };
    }),
});
