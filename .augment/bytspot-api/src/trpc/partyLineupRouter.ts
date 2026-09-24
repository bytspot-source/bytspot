import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../lib/db';
import { canReadPartyLineup, publicTipHandles, tipHandlesInput, tipProvider } from '../services/partyLineupPolicy';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router } from './trpc';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const partyInput = z.object({ partyId: id }).strict();
const changeInput = z.object({ id, version: z.number().int().nonnegative() }).strict();
const write = protectedProcedure.use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-lineup-write' }));
const read = publicProcedure.use(rateLimitMiddleware({ windowMs: 60_000, max: 90, label: 'party-lineup-read' }));
const privateRead = protectedProcedure.use(rateLimitMiddleware({ windowMs: 60_000, max: 90, label: 'party-lineup-private-read' }));
const missing = () => new TRPCError({ code: 'NOT_FOUND', message: 'Party lineup unavailable.' });
const conflict = () => new TRPCError({ code: 'CONFLICT', message: 'This invitation changed. Refresh before trying again.' });

// protectedProcedure checks Redis revocation. Also consult the authoritative DB
// flag here so an outage or a still-valid deleted-account JWT fails closed.
async function activeAccount(tx: Prisma.TransactionClient, userId: string) {
  const account = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
  if (!account) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in with an active account.' });
}
async function hostParty(tx: Prisma.TransactionClient, partyId: string, userId: string) {
  await activeAccount(tx, userId);
  const party = await tx.party.findFirst({
    where: { id: partyId, hostUserId: userId, status: { in: ['draft', 'published'] } }, select: { id: true },
  });
  if (!party) throw missing();
  return party;
}
async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && ['P2034', 'P2002'].includes(String(error.code))) throw conflict();
    throw error;
  }
}

const publicSelect = { id: true, displayName: true, role: true, tipHandles: true, version: true } as const;
const managementSelect = { id: true, partyId: true, invitedUserId: true, displayName: true, role: true, status: true, version: true } as const;
const visibleParty = { status: 'published', host: { deletedAt: null } } as const;
const publishedCredit = { status: 'accepted', confirmedUser: { deletedAt: null } } as const;

async function readableParty(tx: Prisma.TransactionClient, partyId: string, viewerId: string | null) {
  // Select no private contacts, location or guest credentials.
  const party = await tx.party.findFirst({
    where: { id: partyId, ...visibleParty },
    select: { id: true, status: true, hostUserId: true, closedAt: true, startsAt: true, endsAt: true, shareLinkExpiresAt: true },
  });
  if (!party) throw missing();
  // Ignore stale/deleted-account JWTs rather than granting their old pass exception.
  const viewer = viewerId ? await tx.user.findFirst({ where: { id: viewerId, deletedAt: null }, select: { id: true } }) : null;
  const guest = viewer ? await tx.partyGuest.findUnique({ where: { partyId_userId: { partyId, userId: viewer.id } }, select: { accessGranted: true } }) : null;
  if (!canReadPartyLineup(party, viewer?.id ?? null, guest?.accessGranted ?? false)) throw missing();
}

/** Register as events.lineup; this module intentionally does not edit eventsRouter. */
export const partyLineupRouter = router({
  list: read.input(partyInput).query(({ ctx, input }) => transaction(async (tx) => {
    await readableParty(tx, input.partyId, ctx.user?.userId ?? null);
    const entries = await tx.partyPerformer.findMany({
      where: { partyId: input.partyId, ...publishedCredit }, select: publicSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20,
    });
    return { entries: entries.map(({ tipHandles, ...entry }) => ({ ...entry, tips: publicTipHandles(tipHandles) })) };
  })),

  // Revalidate on tap: removed consent, handle updates and expired invites must
  // not turn a cached lineup into a fresh payment handoff. Still no payment state.
  tip: read.input(z.object({ partyId: id, id, version: z.number().int().nonnegative(), provider: tipProvider }).strict())
    .query(({ ctx, input }) => transaction(async (tx) => {
      await readableParty(tx, input.partyId, ctx.user?.userId ?? null);
      const entry = await tx.partyPerformer.findFirst({
        where: { id: input.id, partyId: input.partyId, version: input.version, ...publishedCredit }, select: publicSelect,
      });
      if (!entry) throw missing();
      const tip = publicTipHandles(entry.tipHandles).find((item) => item.provider === input.provider);
      if (!tip) throw missing();
      return { id: entry.id, version: entry.version, displayName: entry.displayName, ...tip };
    })),

  hostList: privateRead.input(partyInput).query(({ ctx, input }) => transaction(async (tx) => {
    await hostParty(tx, input.partyId, ctx.user.userId);
    return { entries: await tx.partyPerformer.findMany({
      where: { partyId: input.partyId, status: { in: ['pending', 'accepted'] } }, select: managementSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20,
    }) };
  })),

  invite: write.input(z.object({
    partyId: id, invitedUserId: id, role: z.enum(['dj', 'mc']),
    displayName: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/),
  }).strict()).mutation(({ ctx, input }) => transaction(async (tx) => {
    await hostParty(tx, input.partyId, ctx.user.userId);
    // No target lookup. Unknown IDs have identical persisted pending rows and
    // host responses. No email, push, delivery or account-existence claims.
    const existing = await tx.partyPerformer.findFirst({ where: {
      partyId: input.partyId, invitedUserId: input.invitedUserId, role: input.role, status: { in: ['pending', 'accepted'] },
    }, select: { id: true } });
    if (existing) return { status: 'recorded' as const };
    if (await tx.partyPerformer.count({ where: { partyId: input.partyId, status: { in: ['pending', 'accepted'] } } }) >= 20) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Remove an entry before adding another. A lineup supports 20 active invitations.' });
    }
    await tx.partyPerformer.create({ data: input });
    return { status: 'recorded' as const };
  })),

  myInvitations: privateRead.input(z.object({ cursor: id.optional() }).strict().optional()).query(({ ctx, input }) => transaction(async (tx) => {
    await activeAccount(tx, ctx.user.userId);
    const rows = await tx.partyPerformer.findMany({
      where: { invitedUserId: ctx.user.userId, status: { in: ['pending', 'accepted'] }, party: visibleParty },
      select: { ...managementSelect, tipHandles: true, party: { select: { title: true, startsAt: true, host: { select: { name: true } } } } },
      orderBy: { id: 'asc' }, take: 51, ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, 50);
    return { entries: page.map(({ party, invitedUserId: _privateId, tipHandles, ...entry }) => ({
      ...entry, partyTitle: party.title, startsAt: party.startsAt.toISOString(), hostName: party.host.name ?? 'Bytspot Host', tips: publicTipHandles(tipHandles),
    })), nextCursor: rows.length > 50 ? page[49].id : null };
  })),

  confirm: write.input(changeInput.extend({ consent: z.literal(true), tips: tipHandlesInput }).strict())
    .mutation(({ ctx, input }) => transaction(async (tx) => {
      await activeAccount(tx, ctx.user.userId);
      const result = await tx.partyPerformer.updateMany({
        where: { id: input.id, version: input.version, invitedUserId: ctx.user.userId, status: { in: ['pending', 'accepted'] }, party: visibleParty },
        data: { status: 'accepted', confirmedUserId: ctx.user.userId, confirmedAt: new Date(), tipHandles: input.tips, version: { increment: 1 } },
      });
      if (result.count !== 1) throw conflict();
      return { status: 'accepted' as const };
    })),

  withdraw: write.input(changeInput).mutation(({ ctx, input }) => transaction(async (tx) => {
    await activeAccount(tx, ctx.user.userId);
    const entry = await tx.partyPerformer.findFirst({ where: { id: input.id, invitedUserId: ctx.user.userId, version: input.version, status: { in: ['pending', 'accepted'] } }, select: { status: true } });
    if (!entry) throw conflict();
    const status = entry.status === 'pending' ? 'declined' : 'withdrawn';
    const result = await tx.partyPerformer.updateMany({
      where: { id: input.id, invitedUserId: ctx.user.userId, version: input.version, status: entry.status },
      data: { status, tipHandles: [], confirmedAt: null, version: { increment: 1 } },
    });
    if (result.count !== 1) throw conflict();
    return { status };
  })),

  remove: write.input(changeInput.extend({ partyId: id }).strict()).mutation(({ ctx, input }) => transaction(async (tx) => {
    await hostParty(tx, input.partyId, ctx.user.userId);
    const result = await tx.partyPerformer.updateMany({
      where: { id: input.id, partyId: input.partyId, version: input.version, status: { in: ['pending', 'accepted'] } },
      data: { status: 'removed', tipHandles: [], confirmedAt: null, version: { increment: 1 } },
    });
    if (result.count !== 1) throw conflict();
    return { status: 'removed' as const };
  })),
});
