import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../lib/db';
import { alertGuestOfRequestAccepted, dispatchPartyAlert } from '../services/partyAlerts';
import {
  requestAllowance, requestNoteBody, requestNoteTransition, requestWindowState, senderFirstName,
  STAGE_SCREEN_LIMIT, tiersWithRequests,
} from '../services/partyRequestNotes';
import { partyEndedAt } from './partyRouter';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const partyInput = z.object({ partyId: id }).strict();
const write = protectedProcedure.use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'party-requests-write' }));
const read = protectedProcedure.use(rateLimitMiddleware({ windowMs: 60_000, max: 120, label: 'party-requests-read' }));
const missing = () => new TRPCError({ code: 'NOT_FOUND', message: 'Party requests unavailable.' });
const conflict = () => new TRPCError({ code: 'CONFLICT', message: 'This request changed. Refresh before trying again.' });

async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && ['P2034', 'P2002'].includes(String(error.code))) throw conflict();
    throw error;
  }
}

async function activeAccount(tx: Prisma.TransactionClient, userId: string) {
  const account = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, name: true } });
  if (!account) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in with an active account.' });
  return account;
}

const partySelect = { id: true, title: true, hostUserId: true, startsAt: true, endsAt: true, closedAt: true, ticketTiers: true } as const;
const liveCredit = { status: 'accepted', confirmedUser: { deletedAt: null } } as const;

async function visibleParty(tx: Prisma.TransactionClient, partyId: string) {
  const party = await tx.party.findFirst({
    where: { id: partyId, status: 'published', moderationHiddenAt: null, host: { deletedAt: null } }, select: partySelect,
  });
  if (!party) throw missing();
  return party;
}

/** The host moderates every note; a confirmed performer moderates notes sent to them. */
async function moderator(tx: Prisma.TransactionClient, partyId: string, userId: string) {
  await activeAccount(tx, userId);
  const party = await visibleParty(tx, partyId);
  const isHost = party.hostUserId === userId;
  const credits = await tx.partyPerformer.findMany({
    where: { partyId, confirmedUserId: userId, ...liveCredit }, select: { id: true },
  });
  if (!isHost && credits.length === 0) throw missing();
  return { party, isHost, performerIds: credits.map((credit) => credit.id) };
}

const noteSelect = {
  id: true, performerId: true, body: true, senderName: true, status: true, acceptedAt: true, playedAt: true, version: true, createdAt: true,
  performer: { select: { displayName: true, role: true } },
} as const;
type NoteRow = Prisma.PartyRequestNoteGetPayload<{ select: typeof noteSelect }>;

function noteView(note: NoteRow) {
  return {
    id: note.id, performerId: note.performerId, performerName: note.performer.displayName, performerRole: note.performer.role,
    body: note.body, senderName: note.senderName, status: note.status, version: note.version,
    createdAt: note.createdAt.toISOString(), acceptedAt: note.acceptedAt?.toISOString() ?? null, playedAt: note.playedAt?.toISOString() ?? null,
  };
}

/** Register as events.requests. */
export const partyRequestsRouter = router({
  /** What the signed-in guest can send right now, and which tiers include requests. */
  eligibility: read.input(partyInput).query(({ ctx, input }) => transaction(async (tx) => {
    await activeAccount(tx, ctx.user.userId);
    const party = await visibleParty(tx, input.partyId);
    const guest = await tx.partyGuest.findUnique({
      where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } },
      select: { status: true, accessGranted: true, ticketTierName: true },
    });
    const allowance = requestAllowance(party.ticketTiers, guest);
    const closesAt = partyEndedAt(party);
    const used = allowance > 0 ? await tx.partyRequestNote.count({ where: { partyId: party.id, senderUserId: ctx.user.userId } }) : 0;
    const window = requestWindowState(party, closesAt, new Date());
    const performers = allowance > 0
      ? await tx.partyPerformer.findMany({
        where: { partyId: party.id, ...liveCredit }, select: { id: true, displayName: true, role: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20,
      })
      : [];
    const state = allowance === 0 ? 'no-request-ticket' : performers.length === 0 ? 'no-lineup' : window;
    return {
      state, allowance, used, remaining: Math.max(0, allowance - used),
      opensAt: party.startsAt.toISOString(), closesAt: closesAt.toISOString(),
      performers, tiersWithRequests: tiersWithRequests(party.ticketTiers),
    };
  })),

  send: write.input(z.object({
    partyId: id, performerId: id, body: requestNoteBody, showName: z.boolean(), idempotencyKey: z.string().uuid(),
  }).strict()).mutation(({ ctx, input }) => transaction(async (tx) => {
    const account = await activeAccount(tx, ctx.user.userId);
    const existing = await tx.partyRequestNote.findUnique({
      where: { senderUserId_idempotencyKey: { senderUserId: account.id, idempotencyKey: input.idempotencyKey } }, select: noteSelect,
    });
    if (existing) {
      if (existing.performerId !== input.performerId || existing.body !== input.body) throw conflict();
      return noteView(existing);
    }
    const party = await visibleParty(tx, input.partyId);
    const guest = await tx.partyGuest.findUnique({
      where: { partyId_userId: { partyId: party.id, userId: account.id } },
      select: { status: true, accessGranted: true, ticketTierName: true },
    });
    const allowance = requestAllowance(party.ticketTiers, guest);
    if (allowance === 0) throw new TRPCError({ code: 'FORBIDDEN', message: "Your ticket doesn't include requests to the lineup." });
    const window = requestWindowState(party, partyEndedAt(party), new Date());
    if (window === 'not-started') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Requests open when the party starts.' });
    if (window !== 'open') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Requests are closed for this party.' });
    const used = await tx.partyRequestNote.count({ where: { partyId: party.id, senderUserId: account.id } });
    if (used >= allowance) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `You've used all ${allowance} request${allowance === 1 ? '' : 's'} your ticket includes.` });
    }
    const performer = await tx.partyPerformer.findFirst({ where: { id: input.performerId, partyId: party.id, ...liveCredit }, select: { id: true } });
    if (!performer) throw new TRPCError({ code: 'NOT_FOUND', message: "That performer isn't on the lineup anymore." });
    const note = await tx.partyRequestNote.create({
      data: {
        partyId: party.id, performerId: performer.id, senderUserId: account.id, idempotencyKey: input.idempotencyKey,
        body: input.body, senderName: input.showName ? senderFirstName(account.name) : null,
      },
      select: noteSelect,
    });
    return noteView(note);
  })),

  /** The signed-in guest's own notes and where each one stands. */
  mine: read.input(partyInput).query(({ ctx, input }) => transaction(async (tx) => {
    await activeAccount(tx, ctx.user.userId);
    const party = await visibleParty(tx, input.partyId);
    const notes = await tx.partyRequestNote.findMany({
      where: { partyId: party.id, senderUserId: ctx.user.userId }, select: noteSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20,
    });
    return { notes: notes.map(noteView) };
  })),

  /** Notes waiting on, or already accepted by, the caller. Dismissed notes are gone. */
  inbox: read.input(partyInput).query(({ ctx, input }) => transaction(async (tx) => {
    const { isHost, performerIds } = await moderator(tx, input.partyId, ctx.user.userId);
    const notes = await tx.partyRequestNote.findMany({
      where: { partyId: input.partyId, status: { in: ['sent', 'accepted', 'played'] }, ...(isHost ? {} : { performerId: { in: performerIds } }) },
      select: noteSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
    });
    return { role: isHost ? 'host' as const : 'performer' as const, notes: notes.map(noteView) };
  })),

  decide: write.input(z.object({
    partyId: id, id, version: z.number().int().nonnegative(), decision: z.enum(['accept', 'played', 'dismiss']),
  }).strict()).mutation(async ({ ctx, input }) => {
    const result = await transaction(async (tx) => {
      const { party, isHost, performerIds } = await moderator(tx, input.partyId, ctx.user.userId);
      const transition = requestNoteTransition(input.decision);
      const now = new Date();
      const updated = await tx.partyRequestNote.updateMany({
        where: {
          id: input.id, partyId: party.id, version: input.version, status: { in: transition.from },
          ...(isHost ? {} : { performerId: { in: performerIds } }),
        },
        data: {
          status: transition.to, decidedByUserId: ctx.user.userId, version: { increment: 1 },
          ...(transition.to === 'accepted' ? { acceptedAt: now } : {}),
          ...(transition.to === 'played' ? { playedAt: now } : {}),
        },
      });
      if (updated.count !== 1) throw conflict();
      const note = await tx.partyRequestNote.findUniqueOrThrow({ where: { id: input.id }, select: { ...noteSelect, senderUserId: true } });
      return { note, partyTitle: party.title };
    });
    if (input.decision === 'accept') {
      dispatchPartyAlert(alertGuestOfRequestAccepted({
        partyId: input.partyId, guestUserId: result.note.senderUserId, performerName: result.note.performer.displayName,
      }));
    }
    return noteView(result.note);
  }),

  /** What the stage screen rolls: accepted and played notes, newest first. */
  screen: read.input(partyInput).query(({ ctx, input }) => transaction(async (tx) => {
    const { party } = await moderator(tx, input.partyId, ctx.user.userId);
    const notes = await tx.partyRequestNote.findMany({
      where: { partyId: party.id, status: { in: ['accepted', 'played'] } }, select: noteSelect,
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }], take: STAGE_SCREEN_LIMIT,
    });
    return { partyTitle: party.title, notes: notes.map(noteView) };
  })),
});
