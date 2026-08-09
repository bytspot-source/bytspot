import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../lib/db';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const circleRole = z.enum(['owner', 'admin', 'member']);
const userIdInput = z.string().trim().min(1).max(128);

function orderedPair(left: string, right: string) {
  return left < right ? { userLowId: left, userHighId: right } : { userLowId: right, userHighId: left };
}

function groupResponse(group: { id: string; name: string; ownerUserId: string; members: Array<{ userId: string; role: string }> }, userId: string) {
  const ownMembership = group.members.find((member) => member.userId === userId);
  return {
    id: group.id,
    name: group.name,
    ownerUserId: group.ownerUserId,
    memberCount: group.members.length,
    memberIds: group.members.map((member) => member.userId),
    role: group.ownerUserId === userId ? 'owner' : ownMembership?.role ?? 'member',
  };
}

async function requireCircleManager(circleId: string, userId: string) {
  const circle = await db.socialCircle.findUnique({
    where: { id: circleId },
    include: { members: { where: { userId }, select: { role: true } } },
  });
  if (!circle) throw new TRPCError({ code: 'NOT_FOUND', message: 'Circle not found.' });
  const role = circle.ownerUserId === userId ? 'owner' : circle.members[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Circle managers can update this Circle.' });
  return circle;
}

export const socialGroupsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const groups = await db.socialCircle.findMany({
      where: {
        OR: [
          { ownerUserId: ctx.user.userId },
          { members: { some: { userId: ctx.user.userId, role: { in: ['owner', 'admin'] } } } },
        ],
      },
      include: { members: { select: { userId: true, role: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return { groups: groups.map((group) => groupResponse(group, ctx.user.userId)) };
  }),

  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'social-circle-create' }))
    .input(z.object({ name: z.string().trim().min(1).max(80), privacy: z.literal('private').default('private') }))
    .mutation(async ({ ctx, input }) => {
      const group = await db.socialCircle.create({
        data: {
          ownerUserId: ctx.user.userId,
          name: input.name,
          privacy: input.privacy,
          members: { create: { userId: ctx.user.userId, role: 'owner' } },
        },
        include: { members: { select: { userId: true, role: true } } },
      });
      return groupResponse(group, ctx.user.userId);
    }),

  members: router({
    add: protectedProcedure
      .input(z.object({ groupId: userIdInput, userId: userIdInput }))
      .mutation(async ({ ctx, input }) => {
        await requireCircleManager(input.groupId, ctx.user.userId);
        if (input.userId !== ctx.user.userId) {
          const connection = await db.socialConnection.findUnique({ where: { userLowId_userHighId: orderedPair(ctx.user.userId, input.userId) } });
          if (!connection) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only accepted Connections can be added to a Circle.' });
        }
        await db.socialCircleMember.upsert({
          where: { circleId_userId: { circleId: input.groupId, userId: input.userId } },
          create: { circleId: input.groupId, userId: input.userId, role: 'member' },
          update: {},
        });
        return { added: true };
      }),

    remove: protectedProcedure
      .input(z.object({ groupId: userIdInput, userId: userIdInput }))
      .mutation(async ({ ctx, input }) => {
        const circle = await requireCircleManager(input.groupId, ctx.user.userId);
        if (input.userId === circle.ownerUserId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The Circle owner cannot be removed.' });
        await db.socialCircleMember.deleteMany({ where: { circleId: input.groupId, userId: input.userId } });
        return { removed: true };
      }),
  }),
});

export const socialInvitesRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'social-invite-create' }))
    .input(z.object({ targetType: z.literal('user'), targetValue: userIdInput, groupId: userIdInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      if (input.targetValue === ctx.user.userId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot invite yourself.' });
      const target = await db.user.findUnique({ where: { id: input.targetValue }, select: { id: true } });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'Person not found.' });
      if (input.groupId) await requireCircleManager(input.groupId, ctx.user.userId);
      const connection = await db.socialConnection.findUnique({ where: { userLowId_userHighId: orderedPair(ctx.user.userId, input.targetValue) } });
      if (connection) throw new TRPCError({ code: 'CONFLICT', message: 'You are already connected.' });
      const existing = await db.socialInvitation.findFirst({
        where: { senderUserId: ctx.user.userId, recipientUserId: input.targetValue, status: 'pending' },
      });
      if (existing) return { id: existing.id, status: existing.status };
      const invite = await db.socialInvitation.create({
        data: { senderUserId: ctx.user.userId, recipientUserId: input.targetValue, circleId: input.groupId },
      });
      return { id: invite.id, status: invite.status };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const invitations = await db.socialInvitation.findMany({
      where: { OR: [{ senderUserId: ctx.user.userId }, { recipientUserId: ctx.user.userId }] },
      include: {
        sender: { select: { id: true, name: true, profileImage: true } },
        recipient: { select: { id: true, name: true, profileImage: true } },
        circle: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { invites: invitations.map((invite) => {
      const incoming = invite.recipientUserId === ctx.user.userId;
      const person = incoming ? invite.sender : invite.recipient;
      return {
        id: invite.id,
        direction: incoming ? 'incoming' : 'outgoing',
        status: invite.status,
        person: { userId: person.id, name: person.name ?? 'Bytspot member', profileImage: person.profileImage },
        groupId: invite.circle?.id ?? null,
        groupName: invite.circle?.name ?? null,
        createdAt: invite.createdAt.toISOString(),
      };
    }) };
  }),

  respond: protectedProcedure
    .input(z.object({ inviteId: userIdInput, response: z.enum(['accepted', 'declined']) }))
    .mutation(async ({ ctx, input }) => db.$transaction(async (tx) => {
      const invite = await tx.socialInvitation.findFirst({ where: { id: input.inviteId, recipientUserId: ctx.user.userId } });
      if (!invite) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invitation not found.' });
      if (invite.status !== 'pending') throw new TRPCError({ code: 'CONFLICT', message: 'Invitation has already been answered.' });
      const now = new Date();
      await tx.socialInvitation.update({ where: { id: invite.id }, data: { status: input.response, respondedAt: now } });
      if (input.response === 'accepted') {
        await tx.socialConnection.upsert({
          where: { userLowId_userHighId: orderedPair(invite.senderUserId, invite.recipientUserId) },
          create: orderedPair(invite.senderUserId, invite.recipientUserId),
          update: {},
        });
        if (invite.circleId) await tx.socialCircleMember.upsert({
          where: { circleId_userId: { circleId: invite.circleId, userId: ctx.user.userId } },
          create: { circleId: invite.circleId, userId: ctx.user.userId, role: 'member' },
          update: {},
        });
      }
      return { status: input.response };
    })),
});

export const socialNetworkRouter = router({
  summary: protectedProcedure.query(async ({ ctx }) => {
    const [connectionCount, circleCount] = await Promise.all([
      db.socialConnection.count({ where: { OR: [{ userLowId: ctx.user.userId }, { userHighId: ctx.user.userId }] } }),
      db.socialCircle.count({
        where: {
          OR: [
            { ownerUserId: ctx.user.userId },
            { members: { some: { userId: ctx.user.userId, role: { in: ['owner', 'admin'] } } } },
          ],
        },
      }),
    ]);
    return { connectionCount, circleCount };
  }),
});