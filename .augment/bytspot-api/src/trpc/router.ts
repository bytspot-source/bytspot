import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { router, publicProcedure, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { cached, getRedis } from '../lib/redis';
import { config } from '../config';
import { sendWelcomeEmail, sendBetaLeadEmail } from '../lib/email';
import { sendPushToAll, getAllSubscriptions, storeSubscription } from '../routes/push';
import { sendCrowdAlertEmail } from '../lib/email';
import { crowdEmitter } from '../routes/venues';
import { runCrowdAlerts } from '../services/crowdAlerts';

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
 * ── Venues sub-router ───────────────────────────────────
 */
const venuesRouter = router({
  /** GET /venues → venues.list */
  list: publicProcedure.query(async () => {
    const venues = await cached('venues:all', 30, async () => {
      const rows = await db.venue.findMany({
        include: {
          crowdLevels: { orderBy: { recordedAt: 'desc' }, take: 1 },
          parking: true,
        },
        orderBy: { name: 'asc' },
      });
      return rows.map((v) => ({
        id: v.id, name: v.name, slug: v.slug, address: v.address,
        lat: v.lat, lng: v.lng, category: v.category, imageUrl: v.imageUrl,
        crowd: v.crowdLevels[0]
          ? { level: v.crowdLevels[0].level, label: v.crowdLevels[0].label, waitMins: v.crowdLevels[0].waitMins, recordedAt: v.crowdLevels[0].recordedAt }
          : null,
        parking: {
          totalAvailable: v.parking.reduce((sum, p) => sum + p.available, 0),
          spots: v.parking.map((p) => ({ name: p.name, type: p.type, available: p.available, total: p.totalSpots, pricePerHr: p.pricePerHr })),
        },
      }));
    });
    return { venues };
  }),

  /** GET /venues/nearby → venues.nearby */
  nearby: publicProcedure
    .input(z.object({ lat: z.number(), lng: z.number(), radius: z.number().optional().default(2000) }))
    .query(async ({ input }) => {
      const { lat, lng, radius } = input;
      const cacheKey = `venues:nearby:${lat.toFixed(4)}:${lng.toFixed(4)}:${radius}`;
      const venues = await cached(cacheKey, 30, async () => {
        const rows = await db.$queryRawUnsafe<
          Array<{ id: string; name: string; slug: string; address: string; lat: number; lng: number; category: string; image_url: string | null; distance: number }>
        >(
          `SELECT id, name, slug, address, lat, lng, category, image_url,
                  ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
           FROM venues
           WHERE location IS NOT NULL
             AND ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
           ORDER BY distance ASC`,
          lng, lat, radius,
        );
        return rows.map((r) => ({
          id: r.id, name: r.name, slug: r.slug, address: r.address,
          lat: r.lat, lng: r.lng, category: r.category, imageUrl: r.image_url,
          distanceMeters: Math.round(r.distance),
        }));
      });
      return { venues };
    }),

  /** GET /venues/:slug → venues.getBySlug */
  getBySlug: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ input }) => {
      const venue = await cached(`venue:${input.slug}`, 15, async () => {
        return db.venue.findUnique({
          where: { slug: input.slug },
          include: {
            crowdLevels: { orderBy: { recordedAt: 'desc' }, take: 24 },
            parking: true,
          },
        });
      });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' });
      return {
        id: venue.id, name: venue.name, slug: venue.slug, address: venue.address,
        lat: venue.lat, lng: venue.lng, category: venue.category, imageUrl: venue.imageUrl,
        crowd: { current: venue.crowdLevels[0] || null, history: venue.crowdLevels },
        parking: venue.parking.map((p) => ({ name: p.name, type: p.type, available: p.available, total: p.totalSpots, pricePerHr: p.pricePerHr })),
      };
    }),

  /** GET /venues/:slug/similar → venues.getSimilar */
  getSimilar: publicProcedure
    .input(z.object({ slug: z.string(), limit: z.number().min(1).max(20).optional().default(5) }))
    .query(async ({ input }) => {
      const { slug, limit } = input;
      const similar = await cached(`venues:similar:${slug}:${limit}`, 60, async () => {
        const rows = await db.$queryRawUnsafe<
          Array<{ id: string; name: string; slug: string; category: string; similarity: number }>
        >(
          `SELECT v2.id, v2.name, v2.slug, v2.category,
                  1 - (v1.embedding <=> v2.embedding) as similarity
           FROM venues v1 CROSS JOIN venues v2
           WHERE v1.slug = $1 AND v2.slug != $1
             AND v1.embedding IS NOT NULL AND v2.embedding IS NOT NULL
           ORDER BY v1.embedding <=> v2.embedding LIMIT $2`,
          slug, limit,
        );
        return rows.map((r) => ({
          id: r.id, name: r.name, slug: r.slug, category: r.category,
          similarity: parseFloat(Number(r.similarity).toFixed(4)),
        }));
      });
      return { similar };
    }),

  /** POST /venues/:id/checkin → venues.checkin (auth required, rate limited) */
  checkin: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'checkin' }))
    .input(z.object({ venueId: z.string(), idempotencyKey: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { venueId, idempotencyKey } = input;

      // Idempotency check
      if (idempotencyKey) {
        const r = getRedis();
        if (r) {
          try {
            const hit = await r.get(`idem:checkin:${idempotencyKey}`);
            if (hit) return JSON.parse(hit) as { success: boolean; newCrowdLevel: number };
          } catch { /* continue */ }
        }
      }

      const venue = await db.venue.findUnique({ where: { id: venueId } });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' });

      const latest = await db.crowdLevel.findFirst({ where: { venueId }, orderBy: { recordedAt: 'desc' } });
      const newLevel = Math.min((latest?.level ?? 1) + 1, 4);
      const labels: Record<number, string> = { 1: 'Chill', 2: 'Active', 3: 'Busy', 4: 'Packed' };

      await db.crowdLevel.create({
        data: { venueId, level: newLevel, label: labels[newLevel], waitMins: newLevel * 5, source: 'user_report' },
      });

      crowdEmitter.emit('crowd-update', {
        venueId, crowd: { level: newLevel, label: labels[newLevel], waitMins: newLevel * 5, recordedAt: new Date().toISOString() },
      });

      const result = { success: true, newCrowdLevel: newLevel };

      if (newLevel === 4) {
        sendPushToAll(`🔴 ${venue.name} is now Packed`, `High crowd at ${venue.name} — plan ahead.`, { venueId, venueName: venue.name, type: 'packed-alert' }).catch(() => {});
        db.user.findMany({ select: { email: true, name: true } }).then((users) => {
          for (const u of users) {
            if (u.email) sendCrowdAlertEmail(u.email, (u.name || '').split(' ')[0], venue.name, venue.slug || venueId).catch(() => {});
          }
        }).catch(() => {});
      }

      if (idempotencyKey) {
        const r = getRedis();
        if (r) r.set(`idem:checkin:${idempotencyKey}`, JSON.stringify(result), 'EX', 86400).catch(() => {});
      }

      return result;
    }),
});

/**
 * ── Rides sub-router ────────────────────────────────────
 */
const ridesRouter = router({
  /** GET /rides → rides.get */
  get: publicProcedure
    .input(z.object({ lat: z.number(), lng: z.number() }))
    .query(async ({ input }) => {
      const { lat, lng } = input;
      const cacheKey = `rides:${lat.toFixed(3)}:${lng.toFixed(3)}`;
      return cached(cacheKey, 60, async () => {
        const basePrice = 8 + Math.random() * 6;
        const day = new Date().getDay();
        const surgeMultiplier = (day === 5 || day === 6) ? 1.2 + Math.random() * 0.8 : 1.0;
        return {
          location: { lat, lng },
          timestamp: new Date().toISOString(),
          providers: [
            { name: 'Uber', products: [
              { type: 'UberX', etaMinutes: Math.floor(3 + Math.random() * 5), priceEstimate: `$${(basePrice * surgeMultiplier).toFixed(2)}`, surgeMultiplier: parseFloat(surgeMultiplier.toFixed(1)) },
              { type: 'Uber Comfort', etaMinutes: Math.floor(5 + Math.random() * 7), priceEstimate: `$${(basePrice * surgeMultiplier * 1.4).toFixed(2)}`, surgeMultiplier: parseFloat(surgeMultiplier.toFixed(1)) },
            ]},
            { name: 'Lyft', products: [
              { type: 'Lyft', etaMinutes: Math.floor(3 + Math.random() * 6), priceEstimate: `$${(basePrice * surgeMultiplier * 0.95).toFixed(2)}`, surgeMultiplier: parseFloat((surgeMultiplier * 0.95).toFixed(1)) },
              { type: 'Lyft XL', etaMinutes: Math.floor(6 + Math.random() * 8), priceEstimate: `$${(basePrice * surgeMultiplier * 1.6).toFixed(2)}`, surgeMultiplier: parseFloat(surgeMultiplier.toFixed(1)) },
            ]},
          ],
        };
      });
    }),
});

/**
 * ── Concierge (AI Chat) sub-router ────────────────────
 */

// Lazy-init OpenAI so missing key doesn't crash startup
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: config.openaiApiKey });
  return _openai;
}

const venueContextSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  crowd: z.object({ level: z.number(), label: z.string(), waitMins: z.number().optional() }).optional(),
  address: z.string().optional(),
});

const quizAnswersSchema = z.object({
  vibe: z.string().optional(),
  walk: z.string().optional(),
  group: z.string().optional(),
}).optional();

function buildSystemPrompt(venues: z.infer<typeof venueContextSchema>[], quiz?: z.infer<typeof quizAnswersSchema>): string {
  const venueList = venues
    .map(v => {
      const crowd = v.crowd
        ? `${v.crowd.label} (${v.crowd.level}/4)${v.crowd.waitMins ? `, ~${v.crowd.waitMins}m wait` : ''}`
        : 'Unknown';
      return `  • [${v.id}] ${v.name} | ${v.category} | Crowd: ${crowd} | ${v.address ?? 'Midtown ATL'}`;
    })
    .join('\n');

  const userCtx = quiz
    ? `\nUser preferences from onboarding: vibe=${quiz.vibe ?? 'any'}, walk=${quiz.walk ?? 'any'}, group=${quiz.group ?? 'any'}`
    : '';

  return `You are the Bytspot Concierge — a sharp, friendly Atlanta Midtown expert powered by live crowd data.${userCtx}

LIVE venue data right now in Midtown Atlanta:
${venueList || '  (no venue data available — suggest checking back shortly)'}

STRICT RULES:
1. Only recommend venues from the live list above. Never invent venue names.
2. Keep replies conversational, confident, 2-4 sentences. Use 1-2 emojis naturally.
3. Always mention the crowd level when recommending (e.g. "it's pretty quiet right now").
4. For parking or ride questions, mention the Map and Discover tabs in the Bytspot app.
5. You MUST respond with valid JSON only — no markdown, no extra text outside the JSON:
   {"reply": "your message here", "venueIds": ["id1", "id2"]}
6. Include 1-3 venue IDs in venueIds only when making venue recommendations. Use empty array otherwise.
7. If nothing matches well, suggest the closest alternative and be honest about why.
8. You know Atlanta Midtown inside out — be confident and local.`;
}

const conciergeRouter = router({
  /** POST /concierge/chat → concierge.chat mutation (auth required — costs $, rate limited) */
  chat: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'concierge' }))
    .input(z.object({
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
      venues: z.array(venueContextSchema).default([]),
      quizAnswers: quizAnswersSchema,
    }))
    .mutation(async ({ input }) => {
      const { messages, venues, quizAnswers } = input;

      if (messages.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'messages array is required' });
      }

      if (!config.openaiApiKey) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'AI concierge not configured' });
      }

      try {
        const openai = getOpenAI();
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system' as const, content: buildSystemPrompt(venues, quizAnswers) },
            ...messages.slice(-10).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          ],
          max_tokens: 300,
          temperature: 0.75,
          response_format: { type: 'json_object' },
        });

        const raw = completion.choices[0]?.message?.content
          ?? '{"reply":"Sorry, I had trouble responding. Try again!","venueIds":[]}';

        let parsed: { reply: string; venueIds: string[] };
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { reply: raw, venueIds: [] };
        }

        return {
          reply: parsed.reply ?? 'Let me find something great for you...',
          venueIds: Array.isArray(parsed.venueIds) ? parsed.venueIds : [],
        };
      } catch (err: any) {
        console.error('[Concierge] OpenAI error:', err?.message);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'AI concierge temporarily unavailable' });
      }
    }),
});

/**
 * ── Payments (Stripe) sub-router ──────────────────────
 */
const paymentsRouter = router({
  /** POST /payments/checkout → payments.checkout mutation (auth required — handles $$) */
  checkout: protectedProcedure
    .input(z.object({
      spotId: z.string(),
      spotName: z.string(),
      address: z.string(),
      duration: z.number(),
      totalCost: z.number(),
    }))
    .mutation(async ({ input }) => {
      if (!config.stripeSecretKey) {
        return {
          url: null as string | null,
          demoMode: true,
          message: 'Stripe not configured — set STRIPE_SECRET_KEY env var on Render',
        };
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const { spotName, address, duration, totalCost, spotId } = input;

      if (!spotName || !totalCost) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'spotName and totalCost are required' });
      }

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          line_items: [{
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(totalCost * 100),
              product_data: {
                name: `Parking — ${spotName}`,
                description: `${duration}h at ${address}`,
              },
            },
            quantity: 1,
          }],
          metadata: { spotId: spotId || '', duration: String(duration) },
          success_url: `${config.frontendUrl}/parking/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${config.frontendUrl}/parking/cancelled`,
        });

        return { url: session.url };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Stripe error';
        console.error('[payments] Stripe error:', msg);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg });
      }
    }),
});

/**
 * ── Providers (Host + Valet) sub-router ───────────────
 */
const providersRouter = router({
  /** GET /providers/status → providers.getStatus query */
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.userId;

    const [hostProfile, valetProfile] = await Promise.all([
      db.hostProfile.findUnique({ where: { userId } }),
      db.valetProfile.findUnique({ where: { userId } }),
    ]);

    return {
      host: hostProfile
        ? {
            id: hostProfile.id,
            status: hostProfile.status,
            currentStep: hostProfile.currentStep,
            onboardingData: hostProfile.onboardingData as Record<string, unknown> | null,
            submittedAt: hostProfile.submittedAt?.toISOString() ?? null,
          }
        : null,
      valet: valetProfile
        ? {
            id: valetProfile.id,
            status: valetProfile.status,
            agreementAcceptedAt: valetProfile.agreementAcceptedAt?.toISOString() ?? null,
          }
        : null,
    };
  }),

  /** POST /providers/host/progress → providers.saveHostProgress mutation */
  saveHostProgress: protectedProcedure
    .input(z.object({
      currentStep: z.number(),
      onboardingData: z.record(z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.userId;
      const { currentStep, onboardingData } = input;

      const jsonData = onboardingData as any;
      const profile = await db.hostProfile.upsert({
        where: { userId },
        create: { userId, status: 'draft', currentStep, onboardingData: jsonData },
        update: { currentStep, onboardingData: jsonData },
      });

      return { profile: { id: profile.id, status: profile.status, currentStep: profile.currentStep } };
    }),

  /** POST /providers/host/submit → providers.submitHostApplication mutation */
  submitHostApplication: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.userId;

    const existing = await db.hostProfile.findUnique({ where: { userId } });
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No host profile found. Complete onboarding first.' });
    }

    const profile = await db.hostProfile.update({
      where: { userId },
      data: { status: 'pending', submittedAt: new Date() },
    });

    return { profile: { id: profile.id, status: profile.status, submittedAt: profile.submittedAt?.toISOString() ?? null } };
  }),

  /** POST /providers/host/reset → providers.resetHostProfile mutation */
  resetHostProfile: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.userId;
    await db.hostProfile.deleteMany({ where: { userId } });
    return { success: true };
  }),

  /** POST /providers/valet/accept-agreement → providers.acceptValetAgreement mutation */
  acceptValetAgreement: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.userId;

    const profile = await db.valetProfile.upsert({
      where: { userId },
      create: { userId, status: 'active', agreementAcceptedAt: new Date() },
      update: { status: 'active', agreementAcceptedAt: new Date() },
    });

    return {
      profile: {
        id: profile.id,
        status: profile.status,
        agreementAcceptedAt: profile.agreementAcceptedAt?.toISOString() ?? null,
      },
    };
  }),
});

/**
 * ── Admin sub-router ────────────────────────────────────
 */
const adminRouter = router({
  /** GET /admin/stats → admin.stats query (admin password required) */
  stats: publicProcedure
    .input(z.object({ adminPassword: z.string() }))
    .query(async ({ input }) => {
      if (!config.adminPassword || input.adminPassword !== config.adminPassword) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Wrong admin password' });
      }

      const r = getRedis();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [totalUsers, newToday, totalCheckins, topVenues] = await Promise.all([
        db.user.count(),
        db.user.count({ where: { createdAt: { gte: today } } }),
        db.crowdLevel.count(),
        db.crowdLevel.groupBy({
          by: ['venueId'],
          _count: { venueId: true },
          orderBy: { _count: { venueId: 'desc' } },
          take: 5,
        }),
      ]);

      let pushSubscribers = 0;
      if (r) {
        try { pushSubscribers = await r.scard('push:subscriptions'); } catch {}
      }

      const venueIds = topVenues.map((v) => v.venueId);
      const venues = await db.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } });
      const nameMap = Object.fromEntries(venues.map((v) => [v.id, v.name]));

      return {
        totalUsers,
        newSignupsToday: newToday,
        totalCheckins,
        pushSubscribers,
        topVenues: topVenues.map((v) => ({
          venueId: v.venueId,
          name: nameMap[v.venueId] || v.venueId,
          checkins: v._count.venueId,
        })),
        generatedAt: new Date().toISOString(),
      };
    }),

  /** POST /admin/generate-invite → admin.generateInvite mutation */
  generateInvite: publicProcedure
    .input(z.object({ adminPassword: z.string(), count: z.number().min(1).max(50).default(1) }))
    .mutation(async ({ input }) => {
      if (!config.adminPassword || input.adminPassword !== config.adminPassword) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Wrong admin password' });
      }

      const r = getRedis();
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const codes: string[] = [];

      for (let i = 0; i < input.count; i++) {
        let code = 'BYT-';
        for (let j = 0; j < 6; j++) code += chars[Math.floor(Math.random() * chars.length)];
        if (r) {
          await r.set(`invite:${code}`, JSON.stringify({ used: false, createdAt: new Date().toISOString() }), 'EX', 60 * 60 * 24 * 30);
        }
        codes.push(code);
      }

      return { codes, message: `Generated ${codes.length} invite code(s) — valid for 30 days` };
    }),

  /** POST /admin/validate-invite → admin.validateInvite mutation (public — called during signup) */
  validateInvite: publicProcedure
    .input(z.object({ code: z.string() }))
    .mutation(async ({ input }) => {
      const code = input.code.toUpperCase().trim();
      if (!code) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No code provided' });
      }

      // If invite system disabled, allow all
      if (!config.adminPassword) {
        return { valid: true };
      }

      const r = getRedis();
      if (!r) {
        return { valid: true, warning: 'Redis unavailable — skipping validation' };
      }

      const raw = await r.get(`invite:${code}`);
      if (!raw) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite code' });
      }

      const data = JSON.parse(raw);
      if (data.used) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Invite code already used' });
      }

      await r.set(`invite:${code}`, JSON.stringify({ ...data, used: true, usedAt: new Date().toISOString() }), 'KEEPTTL');
      return { valid: true };
    }),
});

/**
 * ── Push Notifications sub-router ───────────────────────
 */
const pushRouter = router({
  /** GET /push/vapid-public-key → push.vapidPublicKey query */
  vapidPublicKey: publicProcedure.query(() => {
    return { key: config.vapidPublicKey };
  }),

  /** POST /push/subscribe → push.subscribe mutation (web push VAPID) */
  subscribe: publicProcedure
    .input(z.object({ subscription: z.object({ endpoint: z.string() }).passthrough() }))
    .mutation(async ({ input }) => {
      await storeSubscription(input.subscription);
      return { success: true, type: 'web' as const };
    }),

  /** POST /push/registerNative → push.registerNative mutation (APNs/FCM tokens from Capacitor) */
  registerNative: publicProcedure
    .input(z.object({
      token: z.string().min(1),
      platform: z.enum(['ios', 'android']),
    }))
    .mutation(async ({ input }) => {
      const { storeNativeToken } = await import('../routes/push');
      await storeNativeToken(input.token, input.platform);
      return { success: true, type: 'native' as const };
    }),
});

/**
 * ── Beta Signup (Lead Capture) sub-router ───────────────
 */
const betaSignupRouter = router({
  /** POST /beta-signup → betaSignup.signup mutation */
  signup: publicProcedure
    .input(z.object({
      email: z.string().email('Invalid email address'),
      name: z.string().max(100).optional(),
      source: z.string().max(100).optional(),
    }))
    .mutation(async ({ input }) => {
      const { email, name, source } = input;

      const existing = await db.betaLead.findUnique({ where: { email } });
      if (existing) {
        return { ok: true, alreadyRegistered: true };
      }

      await db.betaLead.create({
        data: { email, name, source: source ?? 'bytspot.com' },
      });

      // Fire welcome email — non-blocking
      const firstName = (name ?? '').split(' ')[0].trim();
      sendBetaLeadEmail(email, firstName).catch(() => {});

      return { ok: true, alreadyRegistered: false };
    }),
});

/**
 * ── Cron sub-router ─────────────────────────────────────
 */
const cronRouter = router({
  /** POST /cron/crowd-alerts → cron.crowdAlerts mutation (protected by cron secret) */
  crowdAlerts: publicProcedure
    .input(z.object({ cronSecret: z.string() }))
    .mutation(async ({ input }) => {
      if (input.cronSecret !== config.cronSecret) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid cron secret' });
      }

      const result = await runCrowdAlerts();
      return { ok: true, ...result };
    }),
});

/**
 * ── Root app router ───────────────────────────────────
 * Merge all sub-routers here.
 */
export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  venues: venuesRouter,
  rides: ridesRouter,
  concierge: conciergeRouter,
  payments: paymentsRouter,
  providers: providersRouter,
  admin: adminRouter,
  push: pushRouter,
  betaSignup: betaSignupRouter,
  cron: cronRouter,
});

/** Export type for frontend — this is the magic for end-to-end safety */
export type AppRouter = typeof appRouter;

