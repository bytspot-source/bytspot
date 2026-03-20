/**
 * Reviews sub-router — Phase 2: Reviews API
 * Handles listing, adding, and aggregating venue reviews.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure } from './trpc';
import { db } from '../lib/db';

export const reviewsRouter = router({
  /** List reviews for a venue (public) */
  list: publicProcedure
    .input(z.object({
      venueId: z.string(),
      limit: z.number().min(1).max(50).optional().default(20),
      cursor: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const rows = await db.review.findMany({
        where: { venueId: input.venueId },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, -1) : rows;
      return {
        items: items.map((r) => ({
          id: r.id,
          userId: r.userId,
          userName: r.user.name ?? 'Anonymous',
          venueId: r.venueId,
          stars: r.stars,
          vibe: r.vibe,
          comment: r.comment,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
      };
    }),

  /** Get aggregate stats for a venue (public) */
  stats: publicProcedure
    .input(z.object({ venueId: z.string() }))
    .query(async ({ input }) => {
      const agg = await db.review.aggregate({
        where: { venueId: input.venueId },
        _avg: { stars: true, vibe: true },
        _count: true,
      });
      return {
        avgStars: agg._avg.stars ? Math.round(agg._avg.stars * 10) / 10 : null,
        avgVibe: agg._avg.vibe ? Math.round(agg._avg.vibe * 10) / 10 : null,
        count: agg._count,
      };
    }),

  /** Add or update a review (one per user per venue) */
  add: protectedProcedure
    .input(z.object({
      venueId: z.string(),
      stars: z.number().int().min(1).max(5),
      vibe: z.number().int().min(1).max(10),
      comment: z.string().max(500).optional().default(''),
    }))
    .mutation(async ({ ctx, input }) => {
      const { venueId, stars, vibe, comment } = input;

      // Verify venue exists
      const venue = await db.venue.findUnique({ where: { id: venueId } });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' });

      const review = await db.review.upsert({
        where: { userId_venueId: { userId: ctx.user.userId, venueId } },
        create: { userId: ctx.user.userId, venueId, stars, vibe, comment },
        update: { stars, vibe, comment },
      });

      // Award points for first review (non-blocking)
      const isNew = review.createdAt.getTime() > Date.now() - 5000; // created within last 5s = new
      if (isNew) {
        db.pointTransaction.create({
          data: {
            userId: ctx.user.userId,
            type: 'earn',
            amount: 15,
            description: `Reviewed ${venue.name}`,
            category: 'review',
          },
        }).catch(() => {});
      }

      return {
        id: review.id,
        venueId: review.venueId,
        stars: review.stars,
        vibe: review.vibe,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
      };
    }),
});

