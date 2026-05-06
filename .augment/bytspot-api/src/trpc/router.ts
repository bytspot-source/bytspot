import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { Entity, type Prisma } from '@prisma/client';
import { router, publicProcedure, protectedProcedure, rateLimitMiddleware, enforceRateLimit } from './trpc';
import { db } from '../lib/db';
import { cached, getRedis } from '../lib/redis';
import { config } from '../config';
import { sendWelcomeEmail, sendBetaLeadEmail } from '../lib/email';
import { sendPushToAll, getAllSubscriptions, storeSubscription } from '../routes/push';
import { sendCrowdAlertEmail } from '../lib/email';
import { crowdEmitter } from '../routes/venues';
import {
  hasVenueTicketingColumns,
  mapPublicVenueDetail,
  mapPublicVenueSummary,
  publicVenueCheckinSelect,
  publicVenueDetailSelect,
  publicVenueDetailSelectWithTicketing,
  publicVenueListSelect,
  publicVenueListSelectWithTicketing,
} from '../lib/venuePublic';
import { runCrowdAlerts } from '../services/crowdAlerts';
import { runCrowdSimulation } from '../services/crowdSimulator';
import { userRouter } from './userRouter';
import { socialRouter } from './socialRouter';
import { reviewsRouter } from './reviewsRouter';
import { eventsRouter, mapTmEvent } from './eventsRouter';
import { placesRouter, gpPost, mapPlace, MappedPlace, SEARCH_FIELDS as GP_SEARCH_FIELDS } from './placesRouter';
import { patchRouter } from './patchRouter';
import { bookingRouter } from './bookingRouter';
import { vendorRouter } from './vendorRouter';
import { auditRouter } from './auditRouter';

const venueHardwarePatchSelect = {
  id: true,
  bindingId: true,
  tagType: true,
  label: true,
  readCounter: true,
  confirmedAt: true,
  updatedAt: true,
} as const;

type VenueHardwarePatchRow = {
  id: string;
  bindingId: string | null;
  tagType: string;
  label: string | null;
  readCounter: number;
  confirmedAt: Date | null;
  updatedAt: Date;
};

function mapVenueHardwarePatch(patch: VenueHardwarePatchRow) {
  return {
    id: patch.id,
    tagType: patch.tagType,
    label: patch.label,
    readCounter: patch.readCounter,
    confirmedAt: patch.confirmedAt?.toISOString() ?? null,
    updatedAt: patch.updatedAt.toISOString(),
    verifiedVenue: true,
  };
}

async function attachVenueHardwarePatches<T extends { id: string }>(venues: T[]): Promise<Array<T & { hardwarePatch: ReturnType<typeof mapVenueHardwarePatch> | null }>> {
  if (!venues.length) return venues.map((venue) => ({ ...venue, hardwarePatch: null }));

  const venueIds = venues.map((venue) => venue.id);
  const patches = await db.hardwarePatch.findMany({
    where: {
      status: 'bound',
      bindingType: 'venue',
      bindingId: { in: venueIds },
    },
    orderBy: [{ confirmedAt: 'desc' }, { updatedAt: 'desc' }],
    select: venueHardwarePatchSelect,
  });

  const patchesByVenueId = new Map<string, ReturnType<typeof mapVenueHardwarePatch>>();
  for (const patch of patches) {
    if (!patch.bindingId || patchesByVenueId.has(patch.bindingId)) continue;
    patchesByVenueId.set(patch.bindingId, mapVenueHardwarePatch(patch));
  }

  return venues.map((venue) => ({
    ...venue,
    hardwarePatch: patchesByVenueId.get(venue.id) ?? null,
  }));
}

function signToken(userId: string, email: string): string {
  return jwt.sign({ userId, email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as string & jwt.SignOptions['expiresIn'],
  });
}

function getRequestIpForRateLimit(ctx: { req?: { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } }): string {
  const forwarded = ctx.req?.headers?.['x-forwarded-for'];
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(',')[0]?.trim() || 'unknown';
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return ctx.req?.ip || ctx.req?.socket?.remoteAddress || 'unknown';
}

function normalizeAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

function enforceSignupRateLimit(ctx: { req?: { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } }): void {
  const ip = getRequestIpForRateLimit(ctx);
  enforceRateLimit({ windowMs: 60 * 60 * 1000, max: 5, label: 'auth:signup' }, `auth:signup:${ip}`);
}

function enforceLoginRateLimit(ctx: { req?: { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } }, email: string): void {
  const ip = getRequestIpForRateLimit(ctx);
  enforceRateLimit({ windowMs: 15 * 60 * 1000, max: 10, label: 'auth:login' }, `auth:login:${ip}:${normalizeAuthEmail(email)}`);
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
  /** POST /trpc/auth.signup */
  signup: publicProcedure
    .input(z.object({
      email: z.string().email().max(255),
      password: z.string().min(8, 'Password must be at least 8 characters').max(128),
      name: z.string().max(100).optional(),
      ref: z.string().max(100).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      enforceSignupRateLimit(ctx);
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

  /** POST /trpc/auth.login */
  login: publicProcedure
    .input(z.object({
      email: z.string().email().max(255),
      password: z.string().min(1).max(128),
    }))
    .mutation(async ({ ctx, input }) => {
      const { email, password } = input;
      enforceLoginRateLimit(ctx, email);
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
  /** GET /venues → venues.list — optional entryType filter */
  list: publicProcedure
    .input(z.object({ entryType: z.enum(['free', 'paid']).optional() }).optional())
    .query(async ({ input }) => {
      const entryFilter = input?.entryType;
      const cacheKey = entryFilter ? `venues:all:${entryFilter}` : 'venues:all';
      const venues = await cached(cacheKey, 30, async () => {
        const ticketingColumnsAvailable = await hasVenueTicketingColumns();
        const rows = ticketingColumnsAvailable
          ? await db.venue.findMany({
              where: entryFilter ? { entryType: entryFilter } : undefined,
              select: publicVenueListSelectWithTicketing,
              orderBy: { name: 'asc' },
            })
          : await db.venue.findMany({
              select: publicVenueListSelect,
              orderBy: { name: 'asc' },
            });

        const mapped = await attachVenueHardwarePatches(rows.map(mapPublicVenueSummary));
        return ticketingColumnsAvailable || !entryFilter
          ? mapped
          : mapped.filter((venue) => venue.entryType === entryFilter);
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
      const ticketingColumnsAvailable = await hasVenueTicketingColumns();
      const venue = await cached(`venue:${input.slug}`, 15, async () => {
        const row = await (ticketingColumnsAvailable
          ? db.venue.findUnique({
              where: { slug: input.slug },
              select: publicVenueDetailSelectWithTicketing,
            })
          : db.venue.findUnique({
              where: { slug: input.slug },
              select: publicVenueDetailSelect,
            }));
        if (!row) return null;
        const [venueWithPatch] = await attachVenueHardwarePatches([mapPublicVenueDetail(row)]);
        return venueWithPatch;
      });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' });
      return venue;
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
    .mutation(async ({ ctx, input }) => {
      const { venueId, idempotencyKey } = input;

      // Idempotency check
      if (idempotencyKey) {
        const r = getRedis();
        if (r) {
          try {
            const hit = await r.get(`idem:checkin:${idempotencyKey}`);
            if (hit) return JSON.parse(hit) as { success: boolean; newCrowdLevel: number; pointsEarned: number };
          } catch { /* continue */ }
        }
      }

      const venue = await db.venue.findUnique({ where: { id: venueId }, select: publicVenueCheckinSelect });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' });

      const latest = await db.crowdLevel.findFirst({ where: { venueId }, orderBy: { recordedAt: 'desc' } });
      const newLevel = Math.min((latest?.level ?? 1) + 1, 4);
      const labels: Record<number, string> = { 1: 'Chill', 2: 'Active', 3: 'Busy', 4: 'Packed' };

      await db.crowdLevel.create({
        data: { venueId, level: newLevel, label: labels[newLevel], waitMins: newLevel * 5, source: 'user_report' },
      });

      // ── Phase 1: Record per-user check-in + award points ──
      const pointsEarned = 10;
      await Promise.all([
        db.checkIn.create({
          data: { userId: ctx.user.userId, venueId, crowdLevel: newLevel, crowdLabel: labels[newLevel], pointsEarned },
        }),
        db.pointTransaction.create({
          data: { userId: ctx.user.userId, type: 'earn', amount: pointsEarned, description: `Checked in at ${venue.name}`, category: 'checkin' },
        }),
      ]).catch(() => { /* non-blocking — don't fail the checkin if points fail */ });

      crowdEmitter.emit('crowd-update', {
        venueId, crowd: { level: newLevel, label: labels[newLevel], waitMins: newLevel * 5, recordedAt: new Date().toISOString() },
      });

      const result = { success: true, newCrowdLevel: newLevel, pointsEarned };

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
  crowd: z.object({ level: z.number(), label: z.string(), waitMins: z.number().nullable().optional() }).optional(),
  address: z.string().optional(),
});

const quizAnswersSchema = z.object({
  vibe: z.string().optional(),
  walk: z.string().optional(),
  group: z.string().optional(),
}).optional();

// ─── RAG: Fetch live context from Google Places + Ticketmaster ───
interface LiveContext {
  nearbyPlaces: MappedPlace[];
  events: Array<{ id: string; title: string; venue: string; date: string; time: string; category: string; price: string }>;
}

const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';

async function fetchLiveContext(): Promise<LiveContext> {
  const result: LiveContext = { nearbyPlaces: [], events: [] };

  // Fetch nearby places (Midtown ATL center: 33.7756, -84.3963)
  const placesPromise = config.googlePlacesApiKey
    ? cached('concierge:places', 600, async () => {
        try {
          const body = {
            locationRestriction: { circle: { center: { latitude: 33.7756, longitude: -84.3963 }, radius: 3000 } },
            maxResultCount: 15, rankPreference: 'DISTANCE',
          };
          const data = await gpPost<{ places?: unknown[] }>('/places:searchNearby', body, GP_SEARCH_FIELDS);
          return (data.places ?? []).map(mapPlace);
        } catch (err: any) {
          console.error('[concierge-rag] Places fetch failed:', err?.message);
          return [];
        }
      })
    : Promise.resolve([]);

  // Fetch tonight's events from Ticketmaster
  const eventsPromise = config.ticketmasterApiKey
    ? cached('concierge:events', 900, async () => {
        try {
          const today = new Date().toISOString().split('T')[0];
          const params = new URLSearchParams({
            apikey: config.ticketmasterApiKey,
            city: 'Atlanta', stateCode: 'GA', size: '10',
            sort: 'date,asc', startDateTime: `${today}T00:00:00Z`,
          });
          const res = await fetch(`${TM_BASE}/events.json?${params}`, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) return [];
          const data = (await res.json()) as { _embedded?: { events?: any[] } };
          return (data._embedded?.events ?? []).map(mapTmEvent);
        } catch (err: any) {
          console.error('[concierge-rag] Events fetch failed:', err?.message);
          return [];
        }
      })
    : Promise.resolve([]);

  const [places, events] = await Promise.all([placesPromise, eventsPromise]);
  result.nearbyPlaces = places ?? [];
  result.events = events ?? [];
  return result;
}

function buildSystemPrompt(
  venues: z.infer<typeof venueContextSchema>[],
  quiz?: z.infer<typeof quizAnswersSchema>,
  liveCtx?: LiveContext,
): string {
  // Merge frontend venues with server-side places (deduplicate by name)
  const venueNames = new Set(venues.map(v => v.name.toLowerCase()));
  const enrichedPlaces = (liveCtx?.nearbyPlaces ?? [])
    .filter(p => !venueNames.has(p.name.toLowerCase()))
    .map(p => `  • [gp:${p.placeId}] ${p.name} | ${p.primaryType ?? 'venue'} | Rating: ${p.rating ?? 'N/A'}⭐ | ${p.address}`);

  const venueList = venues
    .map(v => {
      const crowd = v.crowd
        ? `${v.crowd.label} (${v.crowd.level}/4)${v.crowd.waitMins ? `, ~${v.crowd.waitMins}m wait` : ''}`
        : 'Unknown';
      return `  • [${v.id}] ${v.name} | ${v.category} | Crowd: ${crowd} | ${v.address ?? 'Midtown ATL'}`;
    })
    .join('\n');

  const placesList = enrichedPlaces.length > 0 ? '\n' + enrichedPlaces.join('\n') : '';

  const eventsList = (liveCtx?.events ?? []).length > 0
    ? '\n\nTONIGHT\'S EVENTS IN ATLANTA:\n' + (liveCtx?.events ?? []).map(e =>
        `  🎫 [evt:${e.id}] ${e.title} @ ${e.venue} | ${e.date} ${e.time} | ${e.price}`
      ).join('\n')
    : '';

  const userCtx = quiz
    ? `\nUser preferences from onboarding: vibe=${quiz.vibe ?? 'any'}, walk=${quiz.walk ?? 'any'}, group=${quiz.group ?? 'any'}`
    : '';

  return `You are the Bytspot Concierge — a sharp, friendly Atlanta Midtown expert powered by live crowd data AND tonight's events.${userCtx}

LIVE venue data right now in Midtown Atlanta:
${venueList || '  (no venue data available)'}${placesList}${eventsList}

STRICT RULES:
1. Only recommend venues/events from the live lists above. Never invent names.
2. Keep replies conversational, confident, 2-4 sentences. Use 1-2 emojis naturally.
3. Always mention the crowd level when recommending venues (e.g. "it's pretty quiet right now").
4. When users ask about events or "what's happening tonight", recommend from the events list.
5. For "Plan My Night" requests, suggest a multi-stop itinerary: dinner → drinks/event → late-night spot.
6. For parking or ride questions, mention the Map and Discover tabs in the Bytspot app.
7. You MUST respond with valid JSON only — no markdown, no extra text outside the JSON:
   {"reply": "your message here", "venueIds": ["id1", "id2"], "eventIds": ["evt:id1"]}
8. Include 1-3 venue IDs in venueIds when making venue recommendations. Include event IDs in eventIds when suggesting events. Use empty arrays otherwise.
9. If nothing matches well, suggest the closest alternative and be honest about why.
10. You know Atlanta Midtown inside out — be confident and local.`;
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
    .mutation(async ({ ctx, input }) => {
      const { messages, venues, quizAnswers } = input;

      if (messages.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'messages array is required' });
      }

      if (!config.openaiApiKey) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'AI concierge not configured' });
      }

      // Check premium status for enhanced limits
      const user = await db.user.findUnique({ where: { id: ctx.user.userId }, select: { isPremium: true } });
      const isPremium = user?.isPremium ?? false;

      try {
        // RAG: Fetch live places + events in parallel with OpenAI call setup
        const liveCtx = await fetchLiveContext();

        const openai = getOpenAI();
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system' as const, content: buildSystemPrompt(venues, quizAnswers, liveCtx) },
            ...messages.slice(-10).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          ],
          max_tokens: isPremium ? 800 : 500,
          temperature: 0.75,
          response_format: { type: 'json_object' },
        });

        const raw = completion.choices[0]?.message?.content
          ?? '{"reply":"Sorry, I had trouble responding. Try again!","venueIds":[],"eventIds":[]}';

        let parsed: { reply: string; venueIds: string[]; eventIds?: string[] };
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { reply: raw, venueIds: [], eventIds: [] };
        }

        return {
          reply: parsed.reply ?? 'Let me find something great for you...',
          venueIds: Array.isArray(parsed.venueIds) ? parsed.venueIds : [],
          eventIds: Array.isArray(parsed.eventIds) ? parsed.eventIds : [],
          // Send enriched context back so frontend can render cards
          liveEvents: liveCtx.events.slice(0, 5),
          livePlaces: liveCtx.nearbyPlaces.slice(0, 8).map(p => ({
            placeId: p.placeId, name: p.name, address: p.address,
            rating: p.rating, primaryType: p.primaryType, photoUrls: p.photoUrls.slice(0, 1),
          })),
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
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'payments:checkout' }))
    .input(z.object({
      spotId: z.string().max(100),
      spotName: z.string().max(200),
      address: z.string().max(500),
      duration: z.number().min(0.5).max(24),
      totalCost: z.number().min(0.01).max(10000),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!config.stripeSecretKey) {
        return {
          url: null as string | null,
          demoMode: true,
          message: 'Stripe not configured — set STRIPE_SECRET_KEY env var on Render',
        };
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const { spotName, address, duration, totalCost, spotId } = input;
      const amountCents = Math.round(totalCost * 100);

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
              unit_amount: amountCents,
              product_data: {
                name: `Parking — ${spotName}`,
                description: `${duration}h at ${address}`,
              },
            },
            quantity: 1,
          }],
          metadata: {
            flow: 'parking.checkout',
            source: 'parking.checkout',
            spotId: spotId || '',
            duration: String(duration),
            amountCents: String(amountCents),
            userId: ctx.user.userId,
          },
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
 * ── Subscription (Bytspot Premium) sub-router ────────
 */
const subscriptionPlanSchema = z.enum(['insider-premium', 'vendor-premium', 'valet-premium']);
type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

type SubscriptionUserState = {
  isPremium?: boolean | null;
  isVendorPremium?: boolean | null;
  isValetPremium?: boolean | null;
};

type SubscriptionPointTransaction = {
  type: string;
  amount: number;
};

const POINTS_PER_USD = 100;
const CENTS_PER_USD = 100;
const SUBSCRIPTION_MIN_UNIT_AMOUNT_CENTS = 50;
const SUBSCRIPTION_CREDIT_TYPE = 'SUBSCRIPTION_CREDIT';
const MARKETPLACE_CREDIT_TYPE = 'MARKETPLACE_CREDIT';
const MARKETPLACE_CREDIT_REVERSAL_TYPE = 'MARKETPLACE_CREDIT_REVERSAL';

const subscriptionPlans: Record<SubscriptionPlan, {
  priceId: string;
  productName: string;
  description: string;
  unitAmount: number;
  successPath: string;
  cancelPath: string;
}> = {
  'insider-premium': {
    priceId: config.stripePremiumPriceId,
    productName: 'Bytspot Premium',
    description: 'Ad-free experience, priority concierge, exclusive badge',
    unitAmount: 999,
    successPath: '/premium/success?session_id={CHECKOUT_SESSION_ID}',
    cancelPath: '/premium/cancelled',
  },
  'vendor-premium': {
    priceId: config.stripeVendorPremiumPriceId,
    productName: 'Bytspot Vendor Premium',
    description: 'AI patch placement, demand-window forecasting, and operational efficiency insights',
    unitAmount: 4900,
    successPath: '/provider?premium=success&plan=vendor-premium&session_id={CHECKOUT_SESSION_ID}',
    cancelPath: '/provider?premium=cancelled&plan=vendor-premium',
  },
  'valet-premium': {
    priceId: config.stripeValetPremiumPriceId,
    productName: 'Bytspot Valet Premium',
    description: 'Priority dispatch insight, route quality signals, and premium payout recommendations',
    unitAmount: 1499,
    successPath: '/provider?premium=success&plan=valet-premium&session_id={CHECKOUT_SESSION_ID}',
    cancelPath: '/provider?premium=cancelled&plan=valet-premium',
  },
};

function subscriptionUpdateForPlan(plan: SubscriptionPlan, active: boolean) {
  if (plan === 'vendor-premium') return { isVendorPremium: active };
  if (plan === 'valet-premium') return { isValetPremium: active };
  return { isPremium: active };
}

function entityForSubscriptionPlan(plan: SubscriptionPlan): Entity {
  if (plan === 'vendor-premium') return Entity.VENDOR_SERVICES;
  if (plan === 'valet-premium') return Entity.EXPERIENCES;
  return Entity.BYTSPOT_INC;
}

function isSubscriptionPlanActive(user: SubscriptionUserState, plan: SubscriptionPlan): boolean {
  if (plan === 'vendor-premium') return user.isVendorPremium === true;
  if (plan === 'valet-premium') return user.isValetPremium === true;
  return user.isPremium === true;
}

function activeSubscriptionPlans(user: SubscriptionUserState): SubscriptionPlan[] {
  return [
    ...(user.isPremium ? ['insider-premium' as const] : []),
    ...(user.isVendorPremium ? ['vendor-premium' as const] : []),
    ...(user.isValetPremium ? ['valet-premium' as const] : []),
  ];
}

function isPointDebit(type: string): boolean {
  return type === 'spend' || type === SUBSCRIPTION_CREDIT_TYPE;
}

function getAvailablePoints(txns: SubscriptionPointTransaction[]): number {
  const earned = txns.filter((txn) => !isPointDebit(txn.type)).reduce((sum, txn) => sum + Math.max(0, txn.amount), 0);
  const debited = txns.filter((txn) => isPointDebit(txn.type)).reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
  return Math.max(0, earned - debited);
}

function pointsToCents(points: number): number {
  return Math.floor((Math.max(0, points) * CENTS_PER_USD) / POINTS_PER_USD);
}

function centsToPoints(cents: number): number {
  return Math.ceil((Math.max(0, cents) * POINTS_PER_USD) / CENTS_PER_USD);
}

function insiderUpgradeDiscountCents(user: SubscriptionUserState, plan: SubscriptionPlan): number {
  if (plan !== 'vendor-premium' || user.isPremium !== true) return 0;
  const planAmount = subscriptionPlans[plan].unitAmount;
  return Math.min(subscriptionPlans['insider-premium'].unitAmount, Math.max(0, planAmount - SUBSCRIPTION_MIN_UNIT_AMOUNT_CENTS));
}

function buildSubscriptionOffer(plan: SubscriptionPlan, user: SubscriptionUserState, availablePoints: number, usePoints = false) {
  const baseUnitAmountCents = subscriptionPlans[plan].unitAmount;
  const upgradeDiscountCents = insiderUpgradeDiscountCents(user, plan);
  const maxDiscountableCents = Math.max(0, baseUnitAmountCents - upgradeDiscountCents - SUBSCRIPTION_MIN_UNIT_AMOUNT_CENTS);
  const maxPointsDiscountCents = Math.min(pointsToCents(availablePoints), maxDiscountableCents);
  const pointsToRedeem = usePoints ? centsToPoints(maxPointsDiscountCents) : 0;
  const pointsDiscountCents = usePoints ? maxPointsDiscountCents : 0;
  const totalDiscountCents = upgradeDiscountCents + pointsDiscountCents;
  const finalUnitAmountCents = Math.max(SUBSCRIPTION_MIN_UNIT_AMOUNT_CENTS, baseUnitAmountCents - totalDiscountCents);

  return {
    plan,
    baseUnitAmountCents,
    finalUnitAmountCents,
    upgradeDiscountCents,
    pointsDiscountCents,
    maxPointsDiscountCents,
    pointsToRedeem,
    totalDiscountCents,
    pointsPerUsd: POINTS_PER_USD,
  };
}

function asWebhookMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, v as string]),
  );
}

function readPaymentIntentId(object: Record<string, any>): string | null {
  const paymentIntent = object.payment_intent ?? object.paymentIntent;
  if (typeof paymentIntent === 'string') return paymentIntent;
  if (paymentIntent && typeof paymentIntent.id === 'string') return paymentIntent.id;
  const metadata = asWebhookMetadata(object.metadata);
  return metadata.stripePaymentIntentId ?? metadata.paymentIntentId ?? null;
}

function readRefundId(object: Record<string, any>): string | null {
  if (typeof object.id === 'string' && object.object === 'refund') return object.id;
  const refund = object.refunds?.data?.[0] ?? object.refund;
  if (typeof refund === 'string') return refund;
  if (refund && typeof refund.id === 'string') return refund.id;
  return typeof object.id === 'string' ? object.id : null;
}

function mergedMetadata(existing: unknown, patch: Record<string, unknown>) {
  return {
    ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}),
    ...patch,
  };
}

async function restoreMarketplacePointsForBooking(args: {
  booking: { id: string; userId: string; entity: Entity; metadata: unknown; stripeSessionId: string | null; stripePaymentIntentId: string | null };
  reason: 'refund' | 'dispute';
  stripeRefundId?: string | null;
  stripeDisputeId?: string | null;
}) {
  const metadata = mergedMetadata(args.booking.metadata, {});
  const pointsToRestore = Number.parseInt(String(metadata.pointsToRedeem ?? '0'), 10);
  const pointsDiscountCents = Number.parseInt(String(metadata.pointsDiscountCents ?? '0'), 10);
  if (!Number.isFinite(pointsToRestore) || pointsToRestore <= 0) return;

  try {
    await db.pointTransaction.create({
      data: {
        userId: args.booking.userId,
        type: MARKETPLACE_CREDIT_REVERSAL_TYPE,
        amount: pointsToRestore,
        description: `Restored ${pointsToRestore} marketplace points after ${args.reason} for booking ${args.booking.id} ($${(pointsDiscountCents / 100).toFixed(2)})`,
        category: 'marketplace',
        entity: args.booking.entity,
        stripeRefundId: args.stripeRefundId ?? undefined,
        stripeDisputeId: args.stripeDisputeId ?? undefined,
      },
    });
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error;
  }
}

async function handleMarketplaceRefundEvent(object: Record<string, any>, eventType: string) {
  if (eventType === 'refund.updated' && object.status && object.status !== 'succeeded') {
    return { received: true, ignored: true };
  }
  const stripePaymentIntentId = readPaymentIntentId(object);
  if (!stripePaymentIntentId) return { received: true, ignored: true };
  const booking = await db.booking.findUnique({
    where: { stripePaymentIntentId },
    select: { id: true, userId: true, entity: true, status: true, metadata: true, stripeSessionId: true, stripePaymentIntentId: true },
  });
  if (!booking) return { received: true, ignored: true };

  const stripeRefundId = readRefundId(object);
  await db.booking.update({
    where: { id: booking.id },
    data: {
      status: 'refunded',
      metadata: mergedMetadata(booking.metadata, {
        refund: {
          stripeRefundId,
          stripeChargeId: object.object === 'charge' ? object.id : object.charge ?? null,
          amountRefunded: object.amount_refunded ?? object.amount ?? null,
          status: object.status ?? 'succeeded',
          flow: 'booking.refund',
          receivedAt: new Date().toISOString(),
        },
      }) as Prisma.InputJsonValue,
    },
  });
  await restoreMarketplacePointsForBooking({ booking, reason: 'refund', stripeRefundId });
  return { received: true, bookingId: booking.id, status: 'refunded' };
}

async function handleMarketplaceDisputeEvent(object: Record<string, any>, eventType: string) {
  const stripePaymentIntentId = readPaymentIntentId(object);
  if (!stripePaymentIntentId) return { received: true, ignored: true };
  const booking = await db.booking.findUnique({
    where: { stripePaymentIntentId },
    select: { id: true, userId: true, entity: true, status: true, metadata: true, stripeSessionId: true, stripePaymentIntentId: true },
  });
  if (!booking) return { received: true, ignored: true };

  const stripeDisputeId = typeof object.id === 'string' ? object.id : null;
  const disputeStatus = typeof object.status === 'string' ? object.status : 'needs_response';
  const resolvedStatus = eventType === 'charge.dispute.closed'
    ? (disputeStatus === 'won' ? 'paid' : 'refunded')
    : 'disputed';

  await db.booking.update({
    where: { id: booking.id },
    data: {
      status: resolvedStatus,
      metadata: mergedMetadata(booking.metadata, {
        dispute: {
          stripeDisputeId,
          status: disputeStatus,
          reason: object.reason ?? null,
          amount: object.amount ?? null,
          flow: 'booking.dispute',
          receivedAt: new Date().toISOString(),
        },
      }) as Prisma.InputJsonValue,
    },
  });

  if (resolvedStatus === 'refunded') {
    await restoreMarketplacePointsForBooking({ booking, reason: 'dispute', stripeDisputeId });
  }

  return { received: true, bookingId: booking.id, status: resolvedStatus };
}

function buildSubscriptionOffers(user: SubscriptionUserState, availablePoints: number) {
  return {
    'insider-premium': buildSubscriptionOffer('insider-premium', user, availablePoints, false),
    'vendor-premium': buildSubscriptionOffer('vendor-premium', user, availablePoints, false),
    'valet-premium': buildSubscriptionOffer('valet-premium', user, availablePoints, false),
  };
}

async function resolveStripeCouponDiscount(stripe: Stripe, couponCode?: string) {
  const normalizedCode = couponCode?.trim();
  if (!normalizedCode) return null;

  const promotionCodes = await stripe.promotionCodes.list({ code: normalizedCode, active: true, limit: 1 });
  const promotionCode = promotionCodes.data[0];
  if (promotionCode) {
    const promotionCoupon = (promotionCode as any).coupon;
    const coupon = typeof promotionCoupon === 'string' ? promotionCoupon : promotionCoupon?.id ?? '';
    return {
      discount: { promotion_code: promotionCode.id },
      couponCode: normalizedCode,
      stripePromotionCodeId: promotionCode.id,
      stripeCouponId: coupon,
    };
  }

  try {
    const coupon = await stripe.coupons.retrieve(normalizedCode);
    if (!coupon.valid) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Coupon code is no longer valid' });
    return {
      discount: { coupon: coupon.id },
      couponCode: normalizedCode,
      stripeCouponId: coupon.id,
      stripePromotionCodeId: null,
    };
  } catch (error: any) {
    if (error instanceof TRPCError) throw error;
    if (error?.statusCode === 404 || error?.code === 'resource_missing') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Coupon code was not found' });
    }
    throw error;
  }
}

const subscriptionRouter = router({
  /** POST /subscription/createCheckout → creates Stripe Checkout for premium subscription */
  createCheckout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 3, label: 'subscription:checkout' }))
    .input(z.object({
      plan: subscriptionPlanSchema.optional(),
      usePoints: z.boolean().optional().default(false),
      couponCode: z.string().trim().min(1).max(80).optional(),
    }).optional())
    .mutation(async ({ ctx, input }) => {
    const plan = input?.plan ?? 'insider-premium';
    const planConfig = subscriptionPlans[plan];
    if (!config.stripeSecretKey) {
      return { url: null as string | null, demoMode: true, message: 'Stripe not configured' };
    }
    const stripe = new Stripe(config.stripeSecretKey);
    const userId = ctx.user.userId;

    // Get or create Stripe customer
    let user = await db.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true, email: true, isPremium: true, isVendorPremium: true, isValetPremium: true },
    });
    if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    if (isSubscriptionPlanActive(user, plan)) return { url: null as string | null, demoMode: false, message: 'Already premium', plan };
    const pointTxns = await db.pointTransaction.findMany({
      where: { userId },
      select: { type: true, amount: true },
    });
    const availablePoints = getAvailablePoints(pointTxns);
    const offer = buildSubscriptionOffer(plan, user, availablePoints, input?.usePoints ?? false);

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
      customerId = customer.id;
      await db.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    try {
      const couponDiscount = await resolveStripeCouponDiscount(stripe, input?.couponCode);
      const lineItem = planConfig.priceId && offer.totalDiscountCents === 0
        ? { price: planConfig.priceId, quantity: 1 }
        : {
            price_data: {
              currency: 'usd',
              unit_amount: offer.finalUnitAmountCents,
              recurring: { interval: 'month' as const },
              product_data: { name: planConfig.productName, description: planConfig.description },
            },
            quantity: 1,
          };
      const metadata = {
        userId,
        plan,
        entity: entityForSubscriptionPlan(plan),
        flow: 'subscription.checkout',
        couponCode: couponDiscount?.couponCode ?? '',
        stripeCouponId: couponDiscount?.stripeCouponId ?? '',
        stripePromotionCodeId: couponDiscount?.stripePromotionCodeId ?? '',
        pointsToRedeem: String(offer.pointsToRedeem),
        pointsDiscountCents: String(offer.pointsDiscountCents),
        insiderUpgradeDiscountCents: String(offer.upgradeDiscountCents),
        baseUnitAmountCents: String(offer.baseUnitAmountCents),
        finalUnitAmountCents: String(offer.finalUnitAmountCents),
      };
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [lineItem],
        ...(couponDiscount ? { discounts: [couponDiscount.discount] } : {}),
        metadata,
        subscription_data: { metadata },
        success_url: `${config.frontendUrl}${planConfig.successPath}`,
        cancel_url: `${config.frontendUrl}${planConfig.cancelPath}`,
      });
      return { url: session.url, plan, loyalty: { availablePoints, offer, couponApplied: couponDiscount?.couponCode ?? null } };
    } catch (err: unknown) {
      if (err instanceof TRPCError) throw err;
      const msg = err instanceof Error ? err.message : 'Stripe error';
      console.error('[subscription] Stripe error:', msg);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg });
    }
  }),

  /** GET /subscription/status → returns current user's premium status */
  status: protectedProcedure.query(async ({ ctx }) => {
    const [user, pointTxns] = await Promise.all([
      db.user.findUnique({
        where: { id: ctx.user.userId },
        select: { isPremium: true, isVendorPremium: true, isValetPremium: true },
      }),
      db.pointTransaction.findMany({
        where: { userId: ctx.user.userId },
        select: { type: true, amount: true },
      }),
    ]);
    const subscriptionUser = user ?? {};
    const availablePoints = getAvailablePoints(pointTxns);
    const offers = buildSubscriptionOffers(subscriptionUser, availablePoints);
    return {
      isPremium: user?.isPremium ?? false,
      isVendorPremium: user?.isVendorPremium ?? false,
      isValetPremium: user?.isValetPremium ?? false,
      activePlans: activeSubscriptionPlans(subscriptionUser),
      availablePoints,
      eligibleDiscounts: {
        insiderToVendorPremium: offers['vendor-premium'].upgradeDiscountCents,
      },
      loyalty: {
        availablePoints,
        pointsPerUsd: POINTS_PER_USD,
        centsPerPoint: CENTS_PER_USD / POINTS_PER_USD,
        eligibleDiscounts: {
          insiderToVendorPremium: offers['vendor-premium'].upgradeDiscountCents,
        },
      },
      subscriptionOffers: offers,
    };
  }),

  /** POST /subscription/webhook → handles Stripe webhook events for subscriptions */
  webhook: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 50, label: 'subscription:webhook' }))
    .input(z.object({
      type: z.string().max(100),
      data: z.object({
        object: z.object({
          id: z.string().max(120).optional(),
          metadata: z.object({
            userId: z.string().max(100).optional(),
            plan: subscriptionPlanSchema.optional(),
            entity: z.nativeEnum(Entity).optional(),
            flow: z.string().max(80).optional(),
            bookingId: z.string().max(120).optional(),
            spotId: z.string().max(120).optional(),
            duration: z.string().max(40).optional(),
            amountCents: z.string().max(20).optional(),
            source: z.string().max(80).optional(),
            fromUserId: z.string().max(100).optional(),
            toValetId: z.string().max(100).optional(),
            pointsToRedeem: z.string().max(20).optional(),
            pointsDiscountCents: z.string().max(20).optional(),
          }).optional(),
          mode: z.string().max(50).optional(),
          customer: z.string().max(100).optional(),
        }).passthrough().optional(),
      }).passthrough(),
    }))
    .mutation(async ({ input }) => {
      const { type, data } = input;
      if (type === 'checkout.session.completed') {
        const userId = data?.object?.metadata?.userId;
        const plan = data?.object?.metadata?.plan ?? 'insider-premium';
        if (userId && data?.object?.mode === 'subscription') {
          const entity = data?.object?.metadata?.entity ?? entityForSubscriptionPlan(plan);
          await db.user.update({ where: { id: userId }, data: subscriptionUpdateForPlan(plan, true) });
          const pointsToRedeem = Number.parseInt(data?.object?.metadata?.pointsToRedeem ?? '0', 10);
          const pointsDiscountCents = Number.parseInt(data?.object?.metadata?.pointsDiscountCents ?? '0', 10);
          const stripeSessionId = data?.object?.id;
          if (stripeSessionId && Number.isFinite(pointsToRedeem) && pointsToRedeem > 0) {
            try {
              await db.pointTransaction.create({
                data: {
                  userId,
                  type: SUBSCRIPTION_CREDIT_TYPE,
                  amount: pointsToRedeem,
                  description: `Applied ${pointsToRedeem} points ($${(pointsDiscountCents / 100).toFixed(2)}) to ${plan} subscription checkout ${stripeSessionId}`,
                  category: 'subscription',
                  entity,
                  stripeSessionId,
                },
              });
            } catch (error: any) {
              if (error?.code !== 'P2002') throw error;
            }
          }
          console.log(`[subscription] User ${userId} upgraded to ${plan}`);
        } else if (data?.object?.mode === 'payment' && data?.object?.metadata?.flow === 'parking.checkout') {
          const metadata = data.object.metadata;
          const stripeSessionId = data.object.id;
          const paymentIntent = (data.object as any).payment_intent;
          const stripePaymentIntentId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id ?? null;
          console.log('[subscription:webhook] Parking checkout completed', {
            stripeSessionId,
            stripePaymentIntentId,
            userId: metadata.userId,
            spotId: metadata.spotId,
            amountCents: metadata.amountCents,
          });
          return {
            received: true,
            flow: 'parking.checkout',
            stripeSessionId,
            stripePaymentIntentId,
            spotId: metadata.spotId ?? null,
            userId: metadata.userId ?? null,
            amountCents: metadata.amountCents ?? null,
          };
        } else if (data?.object?.mode === 'payment' && data?.object?.metadata?.flow === 'booking.checkout') {
          const metadata = data.object.metadata;
          const bookingId = metadata.bookingId;
          const stripeSessionId = data.object.id;
          const paymentIntent = (data.object as any).payment_intent;
          const stripePaymentIntentId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id ?? null;
          if (bookingId && stripeSessionId) {
            await db.booking.update({
              where: { id: bookingId },
              data: {
                status: 'paid',
                stripeSessionId,
                stripePaymentIntentId,
                metadata: {
                  ...metadata,
                  stripeSessionId,
                  stripePaymentIntentId,
                  paidAt: new Date().toISOString(),
                  flow: 'booking.checkout.completed',
                },
              },
            });

            const pointsToRedeem = Number.parseInt(metadata.pointsToRedeem ?? '0', 10);
            const pointsDiscountCents = Number.parseInt(metadata.pointsDiscountCents ?? '0', 10);
            if (metadata.userId && Number.isFinite(pointsToRedeem) && pointsToRedeem > 0) {
              try {
                await db.pointTransaction.create({
                  data: {
                    userId: metadata.userId,
                    type: MARKETPLACE_CREDIT_TYPE,
                    amount: pointsToRedeem,
                    description: `Applied ${pointsToRedeem} points ($${(pointsDiscountCents / 100).toFixed(2)}) to marketplace booking ${bookingId} checkout ${stripeSessionId}`,
                    category: 'marketplace',
                    entity: metadata.entity ?? Entity.VENDOR_SERVICES,
                    stripeSessionId,
                    stripePaymentIntentId,
                  },
                });
              } catch (error: any) {
                if (error?.code !== 'P2002') throw error;
              }
            }
          }
        }
      } else if ((type === 'payment_intent.succeeded' || type === 'payment_intent.payment_failed') && data?.object?.metadata?.flow === 'valet.tip') {
        const metadata = data.object.metadata;
        const stripePaymentIntentId = data.object.id ?? null;
        const status = type === 'payment_intent.succeeded' ? 'succeeded' : 'failed';
        console.log('[subscription:webhook] Valet tip payment intent updated', {
          stripePaymentIntentId,
          status,
          fromUserId: metadata.fromUserId,
          toValetId: metadata.toValetId,
          amountCents: metadata.amountCents,
        });
        return {
          received: true,
          flow: 'valet.tip',
          status,
          stripePaymentIntentId,
          fromUserId: metadata.fromUserId ?? null,
          toValetId: metadata.toValetId ?? null,
          amountCents: metadata.amountCents ?? null,
        };
      } else if (type === 'charge.refunded' || type === 'refund.updated') {
        return handleMarketplaceRefundEvent(data.object as Record<string, any>, type);
      } else if (type === 'charge.dispute.created' || type === 'charge.dispute.closed') {
        return handleMarketplaceDisputeEvent(data.object as Record<string, any>, type);
      } else if (type === 'customer.subscription.deleted') {
        const userId = data?.object?.metadata?.userId;
        const plan = data?.object?.metadata?.plan ?? 'insider-premium';
        const customerId = data?.object?.customer;
        if (userId) {
          await db.user.update({ where: { id: userId }, data: subscriptionUpdateForPlan(plan, false) });
          console.log(`[subscription] User ${userId} cancelled ${plan}`);
          return { received: true };
        }
        if (customerId) {
          await db.user.updateMany({ where: { stripeCustomerId: customerId }, data: subscriptionUpdateForPlan(plan, false) });
          console.log(`[subscription] Customer ${customerId} cancelled ${plan}`);
        }
      }
      return { received: true };
    }),
});

/**
 * ── Tips (Valet Tipping) sub-router ─────────────────
 */
const tipsRouter = router({
  /** POST /tips/createTip → creates a Stripe PaymentIntent for a valet tip */
  createTip: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'tips:createTip' }))
    .input(z.object({ valetId: z.string().max(100), amount: z.number().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey) {
        return { clientSecret: null as string | null, demoMode: true, message: 'Stripe not configured' };
      }
      const stripe = new Stripe(config.stripeSecretKey);
      const { valetId, amount } = input;
      const amountCents = Math.round(amount * 100);

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: 'usd',
          metadata: {
            flow: 'valet.tip',
            source: 'tips.createTip',
            fromUserId: ctx.user.userId,
            toValetId: valetId,
            amountCents: String(amountCents),
          },
          description: `Valet tip from ${ctx.user.email}`,
        });

        // Record the tip in the database
        await db.tip.create({
          data: {
            fromUserId: ctx.user.userId,
            toValetId: valetId,
            amount,
            stripePaymentIntentId: paymentIntent.id,
          },
        });

        return { clientSecret: paymentIntent.client_secret };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Stripe error';
        console.error('[tips] Stripe error:', msg);
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

      const [totalUsers, newToday, totalCheckins, topVenues, betaLeadCount, recentBetaLeads] = await Promise.all([
        db.user.count(),
        db.user.count({ where: { createdAt: { gte: today } } }),
        db.crowdLevel.count(),
        db.crowdLevel.groupBy({
          by: ['venueId'],
          _count: { venueId: true },
          orderBy: { _count: { venueId: 'desc' } },
          take: 5,
        }),
        db.betaLead.count(),
        db.betaLead.findMany({
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { email: true, name: true, source: true, createdAt: true },
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
        betaLeadCount,
        betaLeads: recentBetaLeads.map((l) => ({
          email: l.email,
          name: l.name,
          source: l.source,
          createdAt: l.createdAt.toISOString(),
        })),
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
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'beta:signup' }))
    .input(z.object({
      email: z.string().email('Invalid email address').max(255),
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

  /** POST /cron/crowd-sim → cron.crowdSim mutation (protected by cron secret) */
  crowdSim: publicProcedure
    .input(z.object({ cronSecret: z.string() }))
    .mutation(async ({ input }) => {
      if (input.cronSecret !== config.cronSecret) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid cron secret' });
      }

      const result = await runCrowdSimulation();
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
  subscription: subscriptionRouter,
  tips: tipsRouter,
  providers: providersRouter,
  admin: adminRouter,
  push: pushRouter,
  betaSignup: betaSignupRouter,
  cron: cronRouter,
  user: userRouter,
  social: socialRouter,
  reviews: reviewsRouter,
  events: eventsRouter,
  places: placesRouter,
  patch: patchRouter,
  booking: bookingRouter,
  vendors: vendorRouter,
  audit: auditRouter,
});

/** Export type for frontend — this is the magic for end-to-end safety */
export type AppRouter = typeof appRouter;

