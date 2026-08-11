import { createHash, randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const PARTY_MEET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const EXCHANGE_WINDOW_MS = 10 * 60 * 1000;
const opaqueExchangeError = () => new TRPCError({ code: 'NOT_FOUND', message: 'Unable to complete this exchange.' });
const minimalProfile = { id: true, name: true, profileImage: true } as const;
const reportReason = z.enum(['harassment', 'safety', 'impersonation', 'spam', 'other']);

function codeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newExchangeCode(): string {
  return randomBytes(32).toString('base64url');
}

function canonicalPair(first: string, second: string): { userLowId: string; userHighId: string } | null {
  if (first === second) return null;
  return first < second ? { userLowId: first, userHighId: second } : { userLowId: second, userHighId: first };
}

function connectionOther(connection: { id: string; userLowId: string; userHighId: string; expiresAt: Date; userLow: { id: string; name: string | null; profileImage: string | null }; userHigh: { id: string; name: string | null; profileImage: string | null }; party: { title: string } }, userId: string) {
  return {
    id: connection.id,
    expiresAt: connection.expiresAt,
    party: { title: connection.party.title },
    person: connection.userLowId === userId ? connection.userHigh : connection.userLow,
  };
}

async function checkedInGuest(partyId: string, userId: string) {
  return db.partyGuest.findUnique({
    where: { partyId_userId: { partyId, userId } },
    select: { checkedInAt: true, party: { select: { status: true } } },
  });
}

async function requireCheckedInGuest(partyId: string, userId: string): Promise<Date> {
  const guest = await checkedInGuest(partyId, userId);
  if (!guest?.checkedInAt || guest.party.status !== 'published') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'A confirmed Party check-in is required.' });
  }
  return guest.checkedInAt;
}

async function activeConsent(partyId: string, userId: string, now = new Date()) {
  return db.partyMeetConsent.findFirst({
    where: { partyId, userId, withdrawnAt: null, expiresAt: { gt: now } },
    select: { id: true, expiresAt: true },
  });
}

function activeConnectionWhere(userId: string, now = new Date(), partyId?: string) {
  return {
    ...(partyId ? { partyId } : {}),
    deletedAt: null,
    closedAt: null,
    expiresAt: { gt: now },
    OR: [{ userLowId: userId }, { userHighId: userId }],
  };
}

async function globallyBlockPair(tx: Prisma.TransactionClient, blockerUserId: string, blockedUserId: string, now: Date) {
  const pair = canonicalPair(blockerUserId, blockedUserId);
  if (!pair) throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot block yourself.' });
  await tx.userBlock.upsert({
    where: { blockerUserId_blockedUserId: { blockerUserId, blockedUserId } },
    create: { blockerUserId, blockedUserId },
    update: {},
  });
  // A block is global: close every existing Party connection for this exact
  // pair and revoke either user's outstanding bearer exchange codes.
  await tx.partyMeetConnection.updateMany({
    where: { ...pair, deletedAt: null, closedAt: null },
    data: { deletedAt: now, closedAt: now },
  });
  await tx.partyMeetExchange.updateMany({
    where: { issuerUserId: { in: [blockerUserId, blockedUserId] }, redeemedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
}

export const peopleMetRouter = router({
  status: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'party-people-met-status' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const [consent, connections] = await Promise.all([
        db.partyMeetConsent.findUnique({
          where: { partyId_userId: { partyId: input.partyId, userId: ctx.user.userId } },
          select: { optedInAt: true, expiresAt: true, withdrawnAt: true },
        }),
        db.partyMeetConnection.findMany({
          where: activeConnectionWhere(ctx.user.userId, now, input.partyId),
          select: { id: true, userLowId: true, userHighId: true, expiresAt: true, party: { select: { title: true } }, userLow: { select: minimalProfile }, userHigh: { select: minimalProfile } },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      return {
        consent: consent && !consent.withdrawnAt && consent.expiresAt > now
          ? { optedIn: true, expiresAt: consent.expiresAt }
          : { optedIn: false, expiresAt: consent?.expiresAt ?? null },
        connections: connections.map((connection) => connectionOther(connection, ctx.user.userId)),
      };
    }),

  optIn: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-people-met-opt-in' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const checkedInAt = await requireCheckedInGuest(input.partyId, ctx.user.userId);
      const expiresAt = new Date(checkedInAt.getTime() + PARTY_MEET_WINDOW_MS);
      if (expiresAt <= new Date()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This Party consent window is no longer available.' });
      }
      const consent = await db.partyMeetConsent.upsert({
        where: { partyId_userId: { partyId: input.partyId, userId: ctx.user.userId } },
        create: { partyId: input.partyId, userId: ctx.user.userId, checkedInAt, expiresAt },
        // Repeating opt-in intentionally does not change expiry, check-in
        // snapshot, or a prior withdrawal. This is not a renewable consent.
        update: {},
        select: { expiresAt: true, withdrawnAt: true },
      });
      if (consent.withdrawnAt || consent.expiresAt <= new Date()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This Party consent window is no longer available.' });
      }
      return { optedIn: true as const, expiresAt: consent.expiresAt };
    }),

  withdraw: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-people-met-withdraw' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      await db.$transaction(async (tx) => {
        await tx.partyMeetConsent.updateMany({ where: { partyId: input.partyId, userId: ctx.user.userId, withdrawnAt: null }, data: { withdrawnAt: now } });
        await tx.partyMeetExchange.updateMany({ where: { partyId: input.partyId, issuerUserId: ctx.user.userId, revokedAt: null, redeemedAt: null }, data: { revokedAt: now } });
        await tx.partyMeetConnection.updateMany({ where: activeConnectionWhere(ctx.user.userId, now, input.partyId), data: { deletedAt: now, closedAt: now } });
      });
      return { status: 'withdrawn' as const };
    }),

  issueExchangeCode: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-people-met-issue' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const exchangeCode = newExchangeCode();
      const result = await db.$transaction(async (tx) => {
        // Serialize issuance per Party/issuer. The lock is transaction-scoped,
        // so a replacement cannot race another replacement into two live codes.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`party-meet:${input.partyId}:${ctx.user.userId}`}))`;
        const now = new Date();
        const guest = await tx.partyGuest.findUnique({
          where: { partyId_userId: { partyId: input.partyId, userId: ctx.user.userId } },
          select: { checkedInAt: true, party: { select: { status: true } } },
        });
        const consent = await tx.partyMeetConsent.findFirst({
          where: { partyId: input.partyId, userId: ctx.user.userId, withdrawnAt: null, expiresAt: { gt: now } },
          select: { id: true, expiresAt: true },
        });
        if (!guest?.checkedInAt || guest.party.status !== 'published' || !consent) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'An active People You Met opt-in is required.' });
        }
        const expiresAt = new Date(Math.min(consent.expiresAt.getTime(), now.getTime() + EXCHANGE_WINDOW_MS));
        await tx.partyMeetExchange.updateMany({ where: { partyId: input.partyId, issuerUserId: ctx.user.userId, redeemedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
        await tx.partyMeetExchange.create({ data: { partyId: input.partyId, issuerUserId: ctx.user.userId, consentId: consent.id, codeHash: codeHash(exchangeCode), expiresAt } });
        return { expiresAt };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      // Raw bearer code is returned only to its issuer here and is never stored.
      return { exchangeCode, expiresAt: result.expiresAt };
    }),

  redeemExchangeCode: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'party-people-met-redeem' }))
    .input(z.object({ partyId: z.string().min(1).max(128), exchangeCode: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      try {
        return await db.$transaction(async (tx) => {
          const exchange = await tx.partyMeetExchange.findFirst({
            where: { partyId: input.partyId, codeHash: codeHash(input.exchangeCode), redeemedAt: null, revokedAt: null, expiresAt: { gt: now }, consent: { is: { partyId: input.partyId, userId: { not: ctx.user.userId }, withdrawnAt: null, expiresAt: { gt: now } } } },
            select: { id: true, issuerUserId: true, consentId: true, consent: { select: { userId: true, expiresAt: true } } },
          });
          if (!exchange || exchange.issuerUserId === ctx.user.userId || exchange.consent.userId !== exchange.issuerUserId) throw opaqueExchangeError();
          const pair = canonicalPair(exchange.issuerUserId, ctx.user.userId);
          if (!pair) throw opaqueExchangeError();

          const [issuerGuest, redeemerGuest, redeemerConsent, blocked] = await Promise.all([
            tx.partyGuest.findUnique({ where: { partyId_userId: { partyId: input.partyId, userId: exchange.issuerUserId } }, select: { checkedInAt: true, party: { select: { status: true } } } }),
            tx.partyGuest.findUnique({ where: { partyId_userId: { partyId: input.partyId, userId: ctx.user.userId } }, select: { checkedInAt: true, party: { select: { status: true } } } }),
            tx.partyMeetConsent.findFirst({ where: { partyId: input.partyId, userId: ctx.user.userId, withdrawnAt: null, expiresAt: { gt: now } }, select: { id: true, expiresAt: true } }),
            tx.userBlock.findFirst({ where: { OR: [{ blockerUserId: exchange.issuerUserId, blockedUserId: ctx.user.userId }, { blockerUserId: ctx.user.userId, blockedUserId: exchange.issuerUserId }] }, select: { id: true } }),
          ]);
          if (!issuerGuest?.checkedInAt || issuerGuest.party.status !== 'published' ||
              !redeemerGuest?.checkedInAt || redeemerGuest.party.status !== 'published' ||
              !redeemerConsent || blocked) throw opaqueExchangeError();

          const redeemed = await tx.partyMeetExchange.updateMany({ where: { id: exchange.id, redeemedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { redeemedAt: now, redeemedById: ctx.user.userId } });
          if (redeemed.count !== 1) throw opaqueExchangeError();
          const expiresAt = new Date(Math.min(exchange.consent.expiresAt.getTime(), redeemerConsent.expiresAt.getTime()));
          let connection = await tx.partyMeetConnection.findUnique({
            where: { partyId_userLowId_userHighId: { partyId: input.partyId, ...pair } },
            select: { id: true, userLowId: true, userHighId: true, expiresAt: true, deletedAt: true, closedAt: true, party: { select: { title: true } }, userLow: { select: minimalProfile }, userHigh: { select: minimalProfile } },
          });
          if (connection?.deletedAt || connection?.closedAt || (connection && connection.expiresAt <= now)) throw opaqueExchangeError();
          if (!connection) {
            // The unique canonical-pair constraint plus upsert means two
            // simultaneous valid exchanges reconcile to one connection.
            connection = await tx.partyMeetConnection.upsert({
              where: { partyId_userLowId_userHighId: { partyId: input.partyId, ...pair } },
              create: { partyId: input.partyId, ...pair, expiresAt },
              update: {},
              select: { id: true, userLowId: true, userHighId: true, expiresAt: true, deletedAt: true, closedAt: true, party: { select: { title: true } }, userLow: { select: minimalProfile }, userHigh: { select: minimalProfile } },
            });
            if (connection.deletedAt || connection.closedAt || connection.expiresAt <= now) throw opaqueExchangeError();
          }
          return { connection: connectionOther(connection, ctx.user.userId) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        // Never differentiate malformed, expired, blocked, redeemed, or unknown codes.
        throw opaqueExchangeError();
      }
    }),

  connections: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'party-people-met-connections' }))
    .input(z.object({ partyId: z.string().min(1).max(128).optional() }).optional().default({}))
    .query(async ({ ctx, input }) => {
      const connections = await db.partyMeetConnection.findMany({
        where: activeConnectionWhere(ctx.user.userId, new Date(), input.partyId),
        select: { id: true, userLowId: true, userHighId: true, expiresAt: true, party: { select: { title: true } }, userLow: { select: minimalProfile }, userHigh: { select: minimalProfile } },
        orderBy: { createdAt: 'desc' },
      });
      return { connections: connections.map((connection) => connectionOther(connection, ctx.user.userId)) };
    }),

  deleteConnection: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-people-met-delete' }))
    .input(z.object({ connectionId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await db.partyMeetConnection.updateMany({
        where: { id: input.connectionId, OR: [{ userLowId: ctx.user.userId }, { userHighId: ctx.user.userId }], deletedAt: null, closedAt: null },
        data: { deletedAt: new Date(), closedAt: new Date() },
      });
      if (deleted.count !== 1) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found.' });
      return { status: 'deleted' as const };
    }),

  blockConnection: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-people-met-block' }))
    .input(z.object({ connectionId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const connection = await db.partyMeetConnection.findFirst({
        where: { id: input.connectionId, OR: [{ userLowId: ctx.user.userId }, { userHighId: ctx.user.userId }] },
        select: { id: true, partyId: true, userLowId: true, userHighId: true },
      });
      if (!connection) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found.' });
      const otherUserId = connection.userLowId === ctx.user.userId ? connection.userHighId : connection.userLowId;
      await db.$transaction(
        (tx) => globallyBlockPair(tx, ctx.user.userId, otherUserId, now),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { status: 'blocked' as const };
    }),

  reportConnection: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-people-met-report' }))
    .input(z.object({ connectionId: z.string().min(1).max(128), reason: reportReason, details: z.string().trim().min(1).max(1_000).optional(), block: z.boolean().optional().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const connection = await db.partyMeetConnection.findFirst({
        where: { id: input.connectionId, OR: [{ userLowId: ctx.user.userId }, { userHighId: ctx.user.userId }] },
        select: { id: true, partyId: true, userLowId: true, userHighId: true },
      });
      if (!connection) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found.' });
      const reportedUserId = connection.userLowId === ctx.user.userId ? connection.userHighId : connection.userLowId;
      await db.$transaction(async (tx) => {
        await tx.partyMeetReport.create({ data: { connectionId: connection.id, reporterUserId: ctx.user.userId, reportedUserId, reason: input.reason, details: input.details } });
        if (input.block) await globallyBlockPair(tx, ctx.user.userId, reportedUserId, new Date());
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      // Reports are private; callers receive no report record or target detail.
      return { status: 'received' as const };
    }),
});
