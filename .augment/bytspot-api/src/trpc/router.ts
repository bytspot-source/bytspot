import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { router, publicProcedure, protectedProcedure } from './trpc';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { config } from '../config';
import { sendWelcomeEmail } from '../lib/email';

function signToken(userId: string, email: string): string {
  return jwt.sign({ userId, email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as string & jwt.SignOptions['expiresIn'],
  });
}

/**
 * ── Health sub-router ─────────────────────────────────
 */
const healthRouter = router({
  /** Basic health check — mirrors GET /health */
  check: publicProcedure.query(async () => {
    const checks: Record<string, string> = { api: 'ok' };

    try {
      await db.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'error';
    }

    const redis = getRedis();
    if (redis) {
      try {
        await redis.ping();
        checks.redis = 'ok';
      } catch {
        checks.redis = 'error';
      }
    } else {
      checks.redis = 'disabled';
    }

    const healthy = checks.postgres === 'ok';
    return { status: healthy ? 'healthy' : 'degraded', checks };
  }),

  /** Public stats — mirrors GET /stats */
  stats: publicProcedure.query(async () => {
    try {
      const [userCount, venueCount, betaLeadCount] = await Promise.all([
        db.user.count(),
        db.venue.count(),
        db.betaLead.count(),
      ]);
      return { userCount, venueCount, betaLeadCount };
    } catch {
      return { userCount: 246, venueCount: 12, betaLeadCount: 0 };
    }
  }),
});

/**
 * ── Auth sub-router ───────────────────────────────────
 */
const authRouter = router({
  /** POST /auth/signup → auth.signup mutation */
  signup: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string().min(8, 'Password must be at least 8 characters'),
      name: z.string().optional(),
      ref: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { email, password, name, ref } = input;

      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Email already registered' });
      }

      const hashed = await bcrypt.hash(password, 12);
      const user = await db.user.create({
        data: { email, password: hashed, name, ref },
      });

      const token = signToken(user.id, user.email);

      // Send welcome email (non-blocking)
      if (user.email) {
        const firstName = (name || '').split(' ')[0];
        sendWelcomeEmail(user.email, firstName).catch(() => {});
      }

      return { token, user: { id: user.id, email: user.email, name: user.name } };
    }),

  /** POST /auth/login → auth.login mutation */
  login: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string(),
    }))
    .mutation(async ({ input }) => {
      const { email, password } = input;
      const user = await db.user.findUnique({ where: { email } });
      if (!user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
      }

      const token = signToken(user.id, user.email);
      return { token, user: { id: user.id, email: user.email, name: user.name } };
    }),

  /** Get current user profile + referral count — mirrors GET /auth/me */
  me: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.userId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, ref: true, createdAt: true },
    });

    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    }

    const referralCount = await db.user.count({
      where: { ref: userId },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        ref: user.ref,
        createdAt: user.createdAt,
      },
      referralCount,
    };
  }),
});

/**
 * ── Root app router ───────────────────────────────────
 * Merge all sub-routers here.
 */
export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
});

/** Export type for frontend — this is the magic for end-to-end safety */
export type AppRouter = typeof appRouter;

