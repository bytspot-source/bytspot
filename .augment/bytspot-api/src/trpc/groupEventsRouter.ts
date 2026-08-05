/**
 * Group Events sub-router — private RSVP guest lists.
 * Hosts create an event (keyed by its invite slug); guests join via the
 * App Clip after Sign in with Apple. Supports open or approval-gated joins
 * plus a pull-on-open host view of the joined + pending lists.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';

const guestUserSelect = { id: true, name: true, profileImage: true } as const;

/** Party IDs are canonical Party Pass resources, never legacy Group Event IDs.
 * Every legacy route fails closed so a projected or historic GroupEvent row
 * cannot grant, alter, or expose Party participation. */
async function rejectPartyID(eventId: string): Promise<void> {
  const party = await db.party.findUnique({ where: { id: eventId }, select: { id: true } });
  if (party) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Host Studio Party access is only available through its Party Pass.' });
  }
}

type EventRow = {
  id: string;
  hostId: string;
  title: string;
  groupType: string;
  tier: string;
  timing: string;
  scheduledDate: string | null;
  location: string | null;
  theme: string | null;
  instagramHandle: string | null;
  allowNearbyOffers: boolean;
  approvalMode: string;
  createdAt: Date;
};

type GuestRow = {
  userId: string;
  status: string;
  message: string | null;
  createdAt: Date;
  user: { id: string; name: string | null; profileImage: string | null };
};

/** Derive an initials-avatar fallback for guests without a profile image. */
function initialsFor(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function mapEvent(e: EventRow) {
  return {
    id: e.id,
    hostId: e.hostId,
    title: e.title,
    groupType: e.groupType,
    tier: e.tier,
    timing: e.timing,
    scheduledDate: e.scheduledDate,
    location: e.location,
    theme: e.theme,
    instagramHandle: e.instagramHandle,
    allowNearbyOffers: e.allowNearbyOffers,
    approvalMode: e.approvalMode,
    createdAt: e.createdAt.toISOString(),
  };
}

function mapGuest(g: GuestRow) {
  return {
    userId: g.userId,
    name: g.user.name ?? 'Guest',
    profileImage: g.user.profileImage,
    initials: initialsFor(g.user.name),
    status: g.status,
    message: g.message,
    joinedAt: g.createdAt.toISOString(),
  };
}

/** Load an event and assert the caller is its host. */
async function requireHostEvent(eventId: string, userId: string): Promise<EventRow> {
  await rejectPartyID(eventId);
  const event = await db.groupEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
  if (event.hostId !== userId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the host can manage this event.' });
  }
  return event;
}

/** Newly-created invite slugs must carry a high-entropy, unguessable suffix so
 * private events can't be enumerated. The native client appends a 22-char CSPRNG
 * token (`group-<type>-<token>`); we require the final hyphen-delimited segment to
 * be at least 16 url-safe chars, which rejects predictable ids like timestamps.
 * Existing rows (legacy ids created before this rule) may still be updated by
 * their host — the check only applies when creating a brand-new event. */
const UNGUESSABLE_INVITE_SUFFIX = /-[A-Za-z0-9]{16,}$/;

const eventInput = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  groupType: z.string().min(1).max(60),
  tier: z.string().max(30).optional().default('green'),
  timing: z.string().max(30).optional().default('now'),
  scheduledDate: z.string().max(60).optional(),
  location: z.string().max(200).optional(),
  theme: z.string().max(60).optional(),
  instagramHandle: z.string().max(60).optional(),
  allowNearbyOffers: z.boolean().optional().default(true),
  approvalMode: z.enum(['open', 'approval']).optional().default('open'),
});

async function requireEventMembership(tier: string, userId: string): Promise<void> {
  const normalized = tier.toLowerCase();
  if (normalized === 'green') return;
  const user = await db.user.findUnique({ where: { id: userId }, select: { isPremium: true } });
  if (normalized === 'platinum' && user?.isPremium === true) return;
  throw new TRPCError({ code: 'FORBIDDEN', message: `${normalized === 'black' ? 'Black' : 'Platinum'} membership required.` });
}

export const groupEventsRouter = router({
  /** Host: create (or update) an event keyed by its invite slug. */
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'groupEvents:create' }))
    .input(eventInput)
    .mutation(async ({ ctx, input }) => {
      const hostId = ctx.user.userId;
      await rejectPartyID(input.id);
      const existing = await db.groupEvent.findUnique({ where: { id: input.id } });
      if (existing && existing.hostId !== hostId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That invite link is already in use.' });
      }
      if (!existing && !UNGUESSABLE_INVITE_SUFFIX.test(input.id)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invite link is not sufficiently random. Recreate the event to get a secure link.',
        });
      }
      const { id, ...rest } = input;
      const event = await db.groupEvent.upsert({
        where: { id },
        create: { id, hostId, ...rest },
        update: { ...rest },
      });
      return mapEvent(event);
    }),

  /** Guest: join an event. Open events join instantly; approval events go pending.
   * Re-joining never changes an existing row, so a guest the host previously
   * declined stays 'declined' (returned as-is) rather than reverting to pending. */
  join: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'groupEvents:join' }))
    .input(z.object({ eventId: z.string().min(1), message: z.string().max(280).optional() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.userId;
      await rejectPartyID(input.eventId);
      const event = await db.groupEvent.findUnique({ where: { id: input.eventId } });
      if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
      await requireEventMembership(event.tier, userId);

      const status = event.approvalMode === 'approval' ? 'pending' : 'joined';
      const guest = await db.groupEventGuest.upsert({
        where: { eventId_userId: { eventId: input.eventId, userId } },
        create: { eventId: input.eventId, userId, status, message: input.message },
        update: {}, // never downgrade or revive an existing membership on re-join
      });
      return { status: guest.status };
    }),

  /** Guest: the joined guest list for an invite (pull-on-open). Restricted to the
   * host or a caller who is already a *joined* member — private events must not
   * expose their guest list to slug-guessers, nor to pending/declined requesters
   * the host has not approved. */
  guests: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'groupEvents:guests' }))
    .input(z.object({ eventId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await rejectPartyID(input.eventId);
      const event = await db.groupEvent.findUnique({ where: { id: input.eventId } });
      if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
      const userId = ctx.user.userId;
      if (event.hostId !== userId) {
        const membership = await db.groupEventGuest.findUnique({
          where: { eventId_userId: { eventId: input.eventId, userId } },
        });
        if (membership?.status !== 'joined') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only approved guests can see the guest list.' });
        }
      }
      const rows = await db.groupEventGuest.findMany({
        where: { eventId: input.eventId, status: 'joined' },
        include: { user: { select: guestUserSelect } },
        orderBy: { createdAt: 'asc' },
      });
      return {
        eventId: event.id,
        title: event.title,
        count: rows.length,
        guests: rows.map(mapGuest),
      };
    }),

  /** Host: the full event view — joined guests plus pending requests. */
  host: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'groupEvents:host' }))
    .input(z.object({ eventId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const event = await requireHostEvent(input.eventId, ctx.user.userId);
      const rows = await db.groupEventGuest.findMany({
        where: { eventId: input.eventId },
        include: { user: { select: guestUserSelect } },
        orderBy: { createdAt: 'asc' },
      });
      const guests = rows.map(mapGuest);
      return {
        event: mapEvent(event),
        guests: guests.filter((g) => g.status === 'joined'),
        pending: guests.filter((g) => g.status === 'pending'),
      };
    }),

  /** Host: approve or decline a pending guest. */
  decide: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'groupEvents:decide' }))
    .input(z.object({
      eventId: z.string().min(1),
      userId: z.string().min(1),
      decision: z.enum(['approve', 'decline']),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireHostEvent(input.eventId, ctx.user.userId);
      const status = input.decision === 'approve' ? 'joined' : 'declined';
      const result = await db.groupEventGuest.updateMany({
        where: { eventId: input.eventId, userId: input.userId },
        data: { status },
      });
      if (result.count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Guest not found' });
      }
      return { userId: input.userId, status };
    }),

  /** Host: switch an event between open and approval-gated joining. */
  setApprovalMode: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'groupEvents:setApprovalMode' }))
    .input(z.object({ eventId: z.string().min(1), approvalMode: z.enum(['open', 'approval']) }))
    .mutation(async ({ ctx, input }) => {
      await requireHostEvent(input.eventId, ctx.user.userId);
      const event = await db.groupEvent.update({
        where: { id: input.eventId },
        data: { approvalMode: input.approvalMode },
      });
      return { eventId: event.id, approvalMode: event.approvalMode };
    }),
});
