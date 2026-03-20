/**
 * Social sub-router — Phase 1: Follow graph, feed, leaderboard
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, publicProcedure } from './trpc';
import { db } from '../lib/db';

export const socialRouter = router({
  /** Follow a user */
  follow: protectedProcedure
    .input(z.object({ userId: z.string() }))
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
    .input(z.object({ userId: z.string() }))
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
});

