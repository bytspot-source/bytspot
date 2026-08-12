/**
 * Social sub-router — Phase 1: Follow graph, feed, leaderboard.
 * WS-Social Phase 1: connection invitations, privacy-preserving contact
 * graph, circles, and the double-opt-in People You Met surface.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, publicProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';

const surfaceInput = z.string().max(40).optional();
// Clients send only salted SHA-256 hex digests of normalized contact
// identifiers (shared iOS `BytspotContactHasher` contract). Raw emails and
// phone numbers are never accepted, stored, or returned.
const hashedContactInput = z.string().regex(/^[a-f0-9]{64}$/, 'Contact hashes must be lowercase SHA-256 hex digests.');
// Guest states that count as actually attending for People You Met.
const attendedGuestStatuses = ['rsvp', 'ticketed', 'approved', 'checked-in'];

function displayName(name: string | null | undefined): string {
  return name?.trim() || 'Bytspot member';
}

type InvitePair = { fromUserId: string; toUserId: string; status: string };

function relationshipStatus(invites: InvitePair[], viewerId: string, otherUserId: string): 'connected' | 'invite_sent' | 'invite_received' | 'declined' | 'suggested' {
  const pair = invites.find((invite) =>
    (invite.fromUserId === viewerId && invite.toUserId === otherUserId) ||
    (invite.fromUserId === otherUserId && invite.toUserId === viewerId));
  if (!pair) return 'suggested';
  if (pair.status === 'accepted') return 'connected';
  if (pair.status === 'declined') return 'declined';
  return pair.fromUserId === viewerId ? 'invite_sent' : 'invite_received';
}

/** Connection invitations between two members. */
const socialInvitesRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'social:invites-create' }))
    .input(z.object({
      targetType: z.literal('user'),
      targetValue: z.string().min(1).max(128),
      groupId: z.string().min(1).max(128).optional(),
      surface: surfaceInput,
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.targetValue === ctx.user.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot invite yourself.' });
      }
      const target = await db.user.findUnique({ where: { id: input.targetValue }, select: { id: true, name: true } });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'That member was not found.' });
      // A supplied circle must belong to the caller; it is echoed for the
      // client but never grants the recipient access to the circle.
      let circle: { id: string; name: string } | null = null;
      if (input.groupId) {
        circle = await db.socialCircle.findFirst({ where: { id: input.groupId, ownerId: ctx.user.userId }, select: { id: true, name: true } });
        if (!circle) throw new TRPCError({ code: 'NOT_FOUND', message: 'That circle was not found.' });
      }
      const invite = await db.socialInvitation.upsert({
        where: { fromUserId_toUserId: { fromUserId: ctx.user.userId, toUserId: target.id } },
        create: { fromUserId: ctx.user.userId, toUserId: target.id, status: 'pending' },
        update: {},
      });
      return {
        id: invite.id,
        direction: 'outgoing' as const,
        status: invite.status,
        person: { userId: target.id, name: displayName(target.name) },
        groupId: circle?.id ?? null,
        groupName: circle?.name ?? null,
        createdAt: invite.createdAt.toISOString(),
        respondedAt: invite.respondedAt?.toISOString() ?? null,
      };
    }),

  list: protectedProcedure
    .input(z.object({ surface: surfaceInput }).optional())
    .query(async ({ ctx }) => {
      const rows = await db.socialInvitation.findMany({
        where: { OR: [{ fromUserId: ctx.user.userId }, { toUserId: ctx.user.userId }] },
        include: {
          fromUser: { select: { id: true, name: true } },
          toUser: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return {
        invites: rows.map((invite) => {
          const incoming = invite.toUserId === ctx.user.userId;
          const other = incoming ? invite.fromUser : invite.toUser;
          return {
            id: invite.id,
            direction: incoming ? ('incoming' as const) : ('outgoing' as const),
            status: invite.status,
            person: { userId: other.id, name: displayName(other.name) },
            createdAt: invite.createdAt.toISOString(),
            respondedAt: invite.respondedAt?.toISOString() ?? null,
          };
        }),
      };
    }),

  respond: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'social:invites-respond' }))
    .input(z.object({
      inviteId: z.string().min(1).max(128),
      response: z.enum(['accepted', 'declined']),
      surface: surfaceInput,
    }))
    .mutation(async ({ ctx, input }) => {
      // Only the recipient of a still-pending invitation may respond.
      const updated = await db.socialInvitation.updateMany({
        where: { id: input.inviteId, toUserId: ctx.user.userId, status: 'pending' },
        data: { status: input.response, respondedAt: new Date() },
      });
      if (updated.count !== 1) throw new TRPCError({ code: 'NOT_FOUND', message: 'That invitation is not awaiting your response.' });
      return { inviteId: input.inviteId, status: input.response };
    }),
});

/** Circles — owner-run private member groups. */
const socialGroupsRouter = router({
  list: protectedProcedure
    .input(z.object({ surface: surfaceInput }).optional())
    .query(async ({ ctx }) => {
      const circles = await db.socialCircle.findMany({
        where: { OR: [{ ownerId: ctx.user.userId }, { members: { some: { userId: ctx.user.userId } } }] },
        include: { members: { select: { userId: true } } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      return {
        groups: circles.map((circle) => ({
          id: circle.id,
          name: circle.name,
          ownerUserId: circle.ownerId,
          memberCount: circle.members.length,
          memberIds: circle.members.map((member) => member.userId),
          role: circle.ownerId === ctx.user.userId ? ('owner' as const) : ('member' as const),
        })),
      };
    }),

  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'social:groups-create' }))
    .input(z.object({
      name: z.string().trim().min(1).max(100),
      privacy: z.string().max(40).optional(),
      surface: surfaceInput,
    }))
    .mutation(async ({ ctx, input }) => {
      const circle = await db.socialCircle.create({ data: { ownerId: ctx.user.userId, name: input.name } });
      return { id: circle.id, name: circle.name, ownerUserId: circle.ownerId, memberCount: 0, memberIds: [], role: 'owner' as const };
    }),

  members: router({
    add: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'social:groups-members-add' }))
      .input(z.object({
        groupId: z.string().min(1).max(128),
        userId: z.string().min(1).max(128),
        surface: surfaceInput,
      }))
      .mutation(async ({ ctx, input }) => {
        const circle = await db.socialCircle.findFirst({ where: { id: input.groupId, ownerId: ctx.user.userId }, select: { id: true } });
        if (!circle) throw new TRPCError({ code: 'NOT_FOUND', message: 'That circle was not found.' });
        const member = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
        if (!member) throw new TRPCError({ code: 'NOT_FOUND', message: 'That member was not found.' });
        await db.socialCircleMember.upsert({
          where: { circleId_userId: { circleId: circle.id, userId: member.id } },
          create: { circleId: circle.id, userId: member.id },
          update: {},
        });
        return { success: true };
      }),

    remove: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'social:groups-members-remove' }))
      .input(z.object({
        groupId: z.string().min(1).max(128),
        userId: z.string().min(1).max(128),
        surface: surfaceInput,
      }))
      .mutation(async ({ ctx, input }) => {
        const circle = await db.socialCircle.findFirst({ where: { id: input.groupId, ownerId: ctx.user.userId }, select: { id: true } });
        if (!circle) throw new TRPCError({ code: 'NOT_FOUND', message: 'That circle was not found.' });
        await db.socialCircleMember.deleteMany({ where: { circleId: circle.id, userId: input.userId } });
        return { success: true };
      }),
  }),
});

/** People You Met — strictly double-opt-in, per-Party, post-event. */
const socialPeopleMetRouter = router({
  optIn: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'social:people-met-opt-in' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findFirst({ where: { id: input.partyId, status: 'published' }, select: { id: true } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
      const guest = await db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
      if (!guest?.accessGranted || !attendedGuestStatuses.includes(guest.status)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only confirmed Party guests can opt in to People You Met.' });
      }
      await db.partyEncounterOptIn.upsert({
        where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } },
        create: { partyId: party.id, userId: ctx.user.userId },
        update: {},
      });
      return { partyId: party.id, optedIn: true };
    }),

  optOut: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'social:people-met-opt-out' }))
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      // Deleting the row removes the caller from every People You Met surface
      // immediately; no party/guest checks so opt-out always succeeds.
      await db.partyEncounterOptIn.deleteMany({ where: { partyId: input.partyId, userId: ctx.user.userId } });
      return { partyId: input.partyId, optedIn: false };
    }),

  status: protectedProcedure
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const optIn = await db.partyEncounterOptIn.findUnique({
        where: { partyId_userId: { partyId: input.partyId, userId: ctx.user.userId } },
      });
      return { partyId: input.partyId, optedIn: Boolean(optIn) };
    }),

  list: protectedProcedure
    .input(z.object({ partyId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const party = await db.party.findFirst({ where: { id: input.partyId, status: 'published' }, select: { id: true, startsAt: true } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
      if (party.startsAt.getTime() >= Date.now()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'People You Met opens after the Party has started.' });
      }
      const [myOptIn, myGuest] = await Promise.all([
        db.partyEncounterOptIn.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } }),
        db.partyGuest.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } }),
      ]);
      // Fail closed: the caller must be a confirmed attendee who opted in.
      if (!myOptIn || !myGuest?.accessGranted || !attendedGuestStatuses.includes(myGuest.status)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Opt in to People You Met to see other opted-in attendees.' });
      }
      const optIns = await db.partyEncounterOptIn.findMany({
        where: { partyId: party.id, userId: { not: ctx.user.userId } },
        select: { userId: true },
        take: 200,
      });
      const optedInUserIds = optIns.map((optIn) => optIn.userId);
      if (optedInUserIds.length === 0) return { partyId: party.id, items: [] };
      // Only surface people who both opted in AND actually attended.
      const guests = await db.partyGuest.findMany({
        where: { partyId: party.id, userId: { in: optedInUserIds }, accessGranted: true, status: { in: attendedGuestStatuses } },
        include: { user: { select: { id: true, name: true } } },
      });
      if (guests.length === 0) return { partyId: party.id, items: [] };
      const attendeeIds = guests.map((guest) => guest.userId);
      const invites = await db.socialInvitation.findMany({
        where: {
          OR: [
            { fromUserId: ctx.user.userId, toUserId: { in: attendeeIds } },
            { fromUserId: { in: attendeeIds }, toUserId: ctx.user.userId },
          ],
        },
        select: { fromUserId: true, toUserId: true, status: true },
      });
      return {
        partyId: party.id,
        items: guests.map((guest) => {
          const relationship = relationshipStatus(invites, ctx.user.userId, guest.userId);
          return {
            userId: guest.userId,
            name: displayName(guest.user.name),
            inviteExists: relationship !== 'suggested',
            relationshipStatus: relationship,
          };
        }),
      };
    }),
});

export const socialRouter = router({
  invites: socialInvitesRouter,
  groups: socialGroupsRouter,
  peopleMet: socialPeopleMetRouter,

  /**
   * Ranked friend suggestions from the privacy-preserving contact graph:
   * members who mutually share at least one hashed contact with the caller.
   * Declined connection pairs are never resurfaced.
   */
  suggestions: protectedProcedure.query(async ({ ctx }) => {
    const mine = await db.contactHash.findMany({
      where: { userId: ctx.user.userId },
      select: { hashedContact: true },
    });
    if (mine.length === 0) return { items: [] };
    const overlaps = await db.contactHash.findMany({
      where: { hashedContact: { in: mine.map((row) => row.hashedContact) }, userId: { not: ctx.user.userId } },
      select: { userId: true },
    });
    const candidateIds = [...new Set(overlaps.map((row) => row.userId))].slice(0, 50);
    if (candidateIds.length === 0) return { items: [] };
    const [users, invites, circleMemberships] = await Promise.all([
      db.user.findMany({ where: { id: { in: candidateIds } }, select: { id: true, name: true } }),
      db.socialInvitation.findMany({
        where: {
          OR: [
            { fromUserId: ctx.user.userId, toUserId: { in: candidateIds } },
            { fromUserId: { in: candidateIds }, toUserId: ctx.user.userId },
          ],
        },
        select: { fromUserId: true, toUserId: true, status: true },
      }),
      db.socialCircleMember.findMany({
        where: { userId: { in: candidateIds }, circle: { ownerId: ctx.user.userId } },
        select: { userId: true, circleId: true },
      }),
    ]);
    const items = users.flatMap((candidate) => {
      const relationship = relationshipStatus(invites, ctx.user.userId, candidate.id);
      if (relationship === 'declined') return [];
      return [{
        userId: candidate.id,
        name: displayName(candidate.name),
        relationshipStatus: relationship,
        circleIds: circleMemberships.filter((member) => member.userId === candidate.id).map((member) => member.circleId),
      }];
    });
    return { items };
  }),

  /**
   * Syncs the caller's hashed contact book. The stored set is replaced by the
   * submitted set so removed device contacts also disappear server-side.
   * Raw contact data is never accepted or returned — only salted SHA-256
   * digests produced on-device.
   */
  syncCloudContact: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 6, label: 'social:sync-cloud-contact' }))
    .input(z.object({
      source: z.string().min(1).max(40),
      hashes: z.array(hashedContactInput).max(5000),
    }))
    .mutation(async ({ ctx, input }) => {
      const hashes = [...new Set(input.hashes)];
      await db.$transaction([
        db.contactHash.deleteMany({ where: { userId: ctx.user.userId, hashedContact: { notIn: hashes } } }),
        db.contactHash.createMany({
          data: hashes.map((hashedContact) => ({ userId: ctx.user.userId, hashedContact })),
          skipDuplicates: true,
        }),
      ]);
      if (hashes.length === 0) return { synced: 0, matched: 0, mutual: 0 };
      const overlaps = await db.contactHash.findMany({
        where: { hashedContact: { in: hashes }, userId: { not: ctx.user.userId } },
        select: { userId: true, hashedContact: true },
      });
      return {
        synced: hashes.length,
        matched: new Set(overlaps.map((row) => row.hashedContact)).size,
        mutual: new Set(overlaps.map((row) => row.userId)).size,
      };
    }),

  /** Follow a user */
  follow: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'social:follow' }))
    .input(z.object({ userId: z.string().max(100) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.userId === input.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot follow yourself' });
      }
      // Verify target user exists
      const target = await db.user.findUnique({ where: { id: input.userId } });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      await db.follow.upsert({
        where: { followerId_followingId: { followerId: ctx.user.userId, followingId: input.userId } },
        create: { followerId: ctx.user.userId, followingId: input.userId },
        update: {},
      });
      return { success: true };
    }),

  /** Unfollow a user */
  unfollow: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'social:unfollow' }))
    .input(z.object({ userId: z.string().max(100) }))
    .mutation(async ({ ctx, input }) => {
      await db.follow.deleteMany({
        where: { followerId: ctx.user.userId, followingId: input.userId },
      });
      return { success: true };
    }),

  /** Get users I follow */
  following: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db.follow.findMany({
      where: { followerId: ctx.user.userId },
      include: { following: { select: { id: true, name: true, email: true } } },
    });
    return rows.map((r) => ({ userId: r.following.id, name: r.following.name, followedAt: r.createdAt }));
  }),

  /** Get my followers */
  followers: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db.follow.findMany({
      where: { followingId: ctx.user.userId },
      include: { follower: { select: { id: true, name: true, email: true } } },
    });
    return rows.map((r) => ({ userId: r.follower.id, name: r.follower.name, followedAt: r.createdAt }));
  }),

  /** Friends' recent check-in activity feed */
  feed: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(50).optional().default(20) }))
    .query(async ({ ctx, input }) => {
      // Get IDs of users I follow
      const following = await db.follow.findMany({
        where: { followerId: ctx.user.userId },
        select: { followingId: true },
      });
      const followingIds = following.map((f) => f.followingId);
      if (followingIds.length === 0) return { items: [] };

      const checkins = await db.checkIn.findMany({
        where: { userId: { in: followingIds } },
        include: {
          user: { select: { id: true, name: true } },
          venue: { select: { id: true, name: true, slug: true, category: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });

      return {
        items: checkins.map((c) => ({
          id: c.id,
          userId: c.user.id,
          userName: c.user.name ?? 'Anonymous',
          venueId: c.venue.id,
          venueName: c.venue.name,
          venueSlug: c.venue.slug,
          crowdLevel: c.crowdLevel,
          crowdLabel: c.crowdLabel,
          timestamp: c.createdAt.toISOString(),
        })),
      };
    }),

  /** Leaderboard — top users by lifetime points */
  leaderboard: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(50).optional().default(20) }))
    .query(async ({ input }) => {
      // Aggregate points per user
      const rows = await db.pointTransaction.groupBy({
        by: ['userId'],
        _sum: { amount: true },
        where: { type: { not: 'spend' } },
        orderBy: { _sum: { amount: 'desc' } },
        take: input.limit,
      });

      // Fetch user names
      const userIds = rows.map((r) => r.userId);
      const users = await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      });
      const userMap = new Map(users.map((u) => [u.id, u.name ?? 'Anonymous']));

      return rows.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        name: userMap.get(r.userId) ?? 'Anonymous',
        points: r._sum.amount ?? 0,
      }));
    }),

  /** Check if current user follows a specific user */
  isFollowing: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await db.follow.findUnique({
        where: { followerId_followingId: { followerId: ctx.user.userId, followingId: input.userId } },
      });
      return { following: !!row };
    }),

  /** Recent check-ins at a specific venue (public — no auth required) */
  venueCheckins: publicProcedure
    .input(z.object({ venueId: z.string(), limit: z.number().min(1).max(30).optional().default(10) }))
    .query(async ({ input }) => {
      const checkins = await db.checkIn.findMany({
        where: { venueId: input.venueId },
        include: {
          user: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
      return {
        items: checkins.map((c) => ({
          id: c.id,
          userId: c.user.id,
          userName: c.user.name ?? 'Anonymous',
          crowdLevel: c.crowdLevel,
          crowdLabel: c.crowdLabel,
          timestamp: c.createdAt.toISOString(),
        })),
      };
    }),
});

