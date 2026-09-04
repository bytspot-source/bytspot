import { TRPCError } from '@trpc/server';
import { randomInt } from 'crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { router, publicProcedure, protectedProcedure, rateLimitMiddleware } from './trpc';
import { db } from '../lib/db';
import { serializableTransactionWithRetry } from '../lib/transactions';
import { cached, getRedis } from '../lib/redis';
import { config } from '../config';
import { sendWelcomeEmail, sendBetaLeadEmail } from '../lib/email';
import { refreshUserIdentityHashes } from '../services/userIdentityHashes';
import { sendCrowdAlertEmail } from '../lib/email';
import { crowdEmitter } from '../routes/venues';
import { currentPlatformFeeBps, MAX_FEE_BPS, PARTY_TICKET_FEE_SCOPE } from '../services/platformFee';
import { runCrowdAlerts } from '../services/crowdAlerts';
import { claimPackedAlert, entersPacked } from '../services/crowdTransition';
import { runCrowdSimulation } from '../services/crowdSimulator';
import { VISIT_COOLDOWN_MS, crowdLevelForVisitors, movesCrowdLevel, resolvePayout, resolveProof, startOfPointsDay } from '../services/checkinProof';
import { normalizeIosDeviceToken, registerIosPushDevice, unregisterIosPushDevice } from '../services/iosPushDevices';
import { sendVenueCrowdAlert } from '../services/notificationDelivery';
import { appleIdentityAudiences, verifyProviderIdToken } from '../services/providerIdTokenVerifier';
import { resolveProviderIdentity } from '../services/providerIdentityAuth';
import { assertBytspotAdmin, auditAdminAction } from '../services/adminRbac';
import { applyDeletionPolicyOnSignIn } from '../services/accountDeletion';
import { userRouter } from './userRouter';
import { socialRouter } from './socialRouter';
import { reviewsRouter } from './reviewsRouter';
import { eventsRouter, mapTmEvent } from './eventsRouter';
import { placesRouter, gpPost, mapPlace, MappedPlace, SEARCH_FIELDS as GP_SEARCH_FIELDS } from './placesRouter';
import { mobilityRouter } from './mobilityRouter';
import { planRouter } from './planRouter';
import { coffeeRouter } from './coffeeRouter';

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
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'auth:signup' }))
    .input(z.object({
      email: z.string().email().max(255),
      password: z.string().min(8, 'Password must be at least 8 characters').max(128),
      name: z.string().max(100).optional(),
      ref: z.string().max(100).optional(),
    }))
    .mutation(async ({ input }) => {
      const { email, password, name, ref } = input;

      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        // A soft-deleted row still owns the address for the grace period, so
        // the reply must not differ from an active account: doing otherwise
        // would disclose that someone deleted an account at this address.
        throw new TRPCError({ code: 'CONFLICT', message: 'Email already registered' });
      }

      const hashed = await bcrypt.hash(password, 12);
      const user = await db.user.create({
        data: { email, password: hashed, name, ref },
      });

      const token = signToken(user.id, user.email);

      // Identity hashes power contact-graph discovery (non-blocking)
      void refreshUserIdentityHashes(user.id, { email: user.email });

      // Send welcome email (non-blocking)
      if (user.email) {
        const firstName = (name || '').split(' ')[0];
        sendWelcomeEmail(user.email, firstName).catch(() => {});
      }

      return { token, user: { id: user.id, email: user.email, name: user.name } };
    }),

  /** POST /auth/login → auth.login mutation */
  login: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'auth:login' }))
    .input(z.object({
      email: z.string().email().max(255),
      password: z.string().min(1).max(128),
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

      const deletion = await applyDeletionPolicyOnSignIn(user.id);
      if (deletion === 'purge-pending') {
        // Grace period elapsed; the row is awaiting purge and must not be usable.
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
      }
      if (deletion === 'restored') void refreshUserIdentityHashes(user.id, { email: user.email });

      const token = signToken(user.id, user.email);
      return {
        token,
        user: { id: user.id, email: user.email, name: user.name },
        deletionCancelled: deletion === 'restored',
      };
    }),

  /**
   * Verifies a provider-signed Apple ID token, then resolves the immutable
   * Apple subject to a Bytspot account. Supplied email/name are never trusted
   * as identity proof; Apple only supplies them on first authorization.
   */
  appleSignIn: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'auth:apple' }))
    .input(z.object({
      identityToken: z.string().min(1).max(8_192),
      email: z.string().email().max(255).optional(),
      name: z.string().max(100).optional(),
      ref: z.string().max(100).optional(),
    }))
    .mutation(async ({ input }) => {
      if (!config.appleClientId) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Apple sign-in is unavailable' });
      }
      let identity;
      try {
        identity = await verifyProviderIdToken('apple', input.identityToken, appleIdentityAudiences(config.appleClientId));
      } catch {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apple sign-in could not be verified' });
      }
      const result = await resolveProviderIdentity(identity);
      const deletion = await applyDeletionPolicyOnSignIn(result.user.id);
      if (deletion === 'purge-pending') {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This account is no longer available' });
      }
      const token = signToken(result.user.id, result.user.email);
      if (result.isNewUser) sendWelcomeEmail(result.user.email, (result.user.name ?? '').split(' ')[0]).catch(() => {});
      return { token, user: result.user, isNewUser: result.isNewUser, deletionCancelled: deletion === 'restored' };
    }),

  /** Verifies a Google ID token for the configured native iOS OAuth audience. */
  googleSignIn: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'auth:google' }))
    .input(z.object({
      idToken: z.string().min(1).max(8_192),
      surface: z.literal('parker'),
    }))
    .mutation(async ({ input }) => {
      if (!config.googleServerClientId) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Google sign-in is unavailable' });
      }
      let identity;
      try {
        identity = await verifyProviderIdToken('google', input.idToken, config.googleServerClientId);
      } catch {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Google sign-in could not be verified' });
      }
      const result = await resolveProviderIdentity(identity);
      const deletion = await applyDeletionPolicyOnSignIn(result.user.id);
      if (deletion === 'purge-pending') {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This account is no longer available' });
      }
      const token = signToken(result.user.id, result.user.email);
      if (result.isNewUser) sendWelcomeEmail(result.user.email, (result.user.name ?? '').split(' ')[0]).catch(() => {});
      return { token, user: result.user, isNewUser: result.isNewUser, deletionCancelled: deletion === 'restored' };
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
        const rows = await db.venue.findMany({
          where: entryFilter ? { entryType: entryFilter } : undefined,
          include: {
            crowdLevels: { orderBy: { recordedAt: 'desc' }, take: 1 },
            parking: true,
          },
          orderBy: { name: 'asc' },
        });
        return rows.map((v) => ({
          id: v.id, name: v.name, slug: v.slug, address: v.address,
          lat: v.lat, lng: v.lng, category: v.category, imageUrl: v.imageUrl,
          entryType: (v.entryType ?? 'free') as 'free' | 'paid',
          entryPrice: v.entryPrice ?? null,
          ticketUrl: v.ticketUrl ?? null,
          crowd: v.crowdLevels[0]
            ? { level: v.crowdLevels[0].level, label: v.crowdLevels[0].label, waitMins: v.crowdLevels[0].waitMins, source: v.crowdLevels[0].source, recordedAt: v.crowdLevels[0].recordedAt instanceof Date ? v.crowdLevels[0].recordedAt.toISOString() : String(v.crowdLevels[0].recordedAt) }
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
        entryType: (venue.entryType ?? 'free') as 'free' | 'paid',
        entryPrice: venue.entryPrice ?? null,
        ticketUrl: venue.ticketUrl ?? null,
        crowd: {
          current: venue.crowdLevels[0]
            ? { ...venue.crowdLevels[0], recordedAt: venue.crowdLevels[0].recordedAt instanceof Date ? venue.crowdLevels[0].recordedAt.toISOString() : String(venue.crowdLevels[0].recordedAt) }
            : null,
          history: venue.crowdLevels.map((cl) => ({ ...cl, recordedAt: cl.recordedAt instanceof Date ? cl.recordedAt.toISOString() : String(cl.recordedAt) })),
        },
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
    .input(z.object({
      venueId: z.string(),
      idempotencyKey: z.string().optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { venueId, idempotencyKey } = input;

      // Idempotency check
      if (idempotencyKey) {
        const r = getRedis();
        if (r) {
          try {
            const hit = await r.get(`idem:checkin:${idempotencyKey}`);
            if (hit) return JSON.parse(hit) as { success: boolean; newCrowdLevel: number; pointsEarned: number; proof: string; pointsReason: string };
          } catch { /* continue */ }
        }
      }

      const venue = await db.venue.findUnique({ where: { id: venueId } });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' });

      const device = input.lat !== undefined && input.lng !== undefined ? { lat: input.lat, lng: input.lng } : null;
      const { proof, distanceMeters: distanceM } = resolveProof(device, venue);

      const labels: Record<number, string> = { 1: 'Chill', 2: 'Active', 3: 'Busy', 4: 'Packed' };
      const now = new Date();

      // ── Phase 1: Record per-user check-in + award points ──
      //
      // Read and write in one serializable transaction. Atomicity alone is not
      // enough: the ceiling is read and then written against, so under the
      // default isolation two check-ins could both see 40 and both pay 10.
      // Atomicity is still the other half — the cooldown reads the check-in
      // row, so a torn write would leave a member blocked from earning at a
      // venue they were never actually paid for. Retried once, because losing
      // the race is not the member's fault.
      const dayStart = startOfPointsDay(now);
      const { payout, newLevel, enteredPacked } = await serializableTransactionWithRetry(async (tx) => {
        // The previous level is read inside the transaction because the packed
        // alert is decided from it: read outside, two check-ins could both see
        // Busy, both compute Packed, and both notify every member. Serialized,
        // the loser re-reads Packed and stays quiet.
        const latest = await tx.crowdLevel.findFirst({ where: { venueId }, orderBy: { recordedAt: 'desc' } });

        // The level is how many different people were here in the last hour,
        // not the previous level plus one: a tap is not evidence of a crowd,
        // and a member tapping repeatedly is still one person in the room.
        const recentVisitors = movesCrowdLevel(proof)
          ? await tx.checkIn.findMany({
              where: { venueId, proof: { not: 'self_reported' }, createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
              select: { userId: true },
              distinct: ['userId'],
            })
          : [];
        // An unproven tap leaves the venue's crowd level exactly where it was.
        // Someone at home must not be able to report a bar as packed.
        const level = movesCrowdLevel(proof)
          ? crowdLevelForVisitors(new Set([...recentVisitors.map((v) => v.userId), ctx.user.userId]).size)
          : latest?.level ?? 1;

        const [lastPaidVisit, earnedToday] = await Promise.all([
          tx.checkIn.findFirst({
            // Bounded by the cooldown itself: an older row is already
            // indistinguishable from none, and the bound caps the scan.
            where: {
              userId: ctx.user.userId,
              venueId,
              pointsEarned: { gt: 0 },
              createdAt: { gte: new Date(now.getTime() - VISIT_COOLDOWN_MS) },
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
          // The ceiling counts the same rows the cooldown reads. The ledger is
          // the member's readable history, not the accounting source of truth,
          // so the two rules cannot disagree about what was paid.
          tx.checkIn.aggregate({
            _sum: { pointsEarned: true },
            where: { userId: ctx.user.userId, createdAt: { gte: dayStart } },
          }),
        ]);

        const award = resolvePayout({
          proof,
          lastPaidVisitAt: lastPaidVisit?.createdAt ?? null,
          pointsEarnedToday: earnedToday._sum.pointsEarned ?? 0,
          now,
        });

        // The recorded crowd level belongs to the same transaction: a venue
        // must not be reported busier by a check-in that then failed.
        if (movesCrowdLevel(proof)) {
          await tx.crowdLevel.create({
            data: { venueId, level, label: labels[level], waitMins: level * 5, source: 'user_report' },
          });
        }

        await tx.checkIn.create({
          data: { userId: ctx.user.userId, venueId, crowdLevel: level, crowdLabel: labels[level], pointsEarned: award.points, proof, distanceM },
        });
        // No ledger row for a tap that earned nothing: a zero-point entry is
        // noise in the member's own history.
        if (award.points > 0) {
          await tx.pointTransaction.create({
            data: { userId: ctx.user.userId, type: 'earn', amount: award.points, description: `Checked in at ${venue.name}`, category: 'checkin' },
          });
        }
        return { payout: award, newLevel: level, enteredPacked: movesCrowdLevel(proof) && entersPacked(latest?.level, level) };
      }, 'Another check-in was recorded at the same moment. Try again.');

      crowdEmitter.emit('crowd-update', {
        venueId, crowd: { level: newLevel, label: labels[newLevel], waitMins: newLevel * 5, source: 'user_report', recordedAt: new Date().toISOString() },
      });

      const { points: pointsEarned, reason: pointsReason } = payout;
      const result = { success: true, newCrowdLevel: newLevel, pointsEarned, proof, pointsReason };

      if (enteredPacked && await claimPackedAlert(venueId)) {
        sendVenueCrowdAlert({
          venueId,
          venueName: venue.name,
          venueSlug: venue.slug,
          title: `🔴 ${venue.name} is now Packed`,
          body: `High crowd at ${venue.name} — plan ahead.`,
          type: 'packed',
        }).catch(() => {});
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
  /** Legacy endpoint retained only to avoid simulated provider estimates. */
  get: publicProcedure
    .input(z.object({ lat: z.number(), lng: z.number() }))
    .query(async () => {
      return {
        available: false,
        providers: [],
        message: 'Provider estimates are unavailable. Premium members can request an authorized Uber or Lyft handoff through mobility.',
      };
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
    ? cached('concierge:v2:places', 600, async () => {
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
 * ── Subscription (Bytspot Premium) sub-router ────────
 */
const subscriptionRouter = router({
  /** POST /subscription/createCheckout → creates Stripe Checkout for premium subscription */
  createCheckout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 3, label: 'subscription:checkout' }))
    .mutation(async ({ ctx }) => {
    if (!config.stripeSecretKey) {
      return { url: null as string | null, demoMode: true, message: 'Stripe not configured' };
    }
    const stripe = new Stripe(config.stripeSecretKey);
    const userId = ctx.user.userId;

    // Get or create Stripe customer
    let user = await db.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true, email: true, isPremium: true, membershipTier: true } });
    if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    if (user.membershipTier !== 'green') return { url: null as string | null, demoMode: false, message: 'Already premium' };

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
      customerId = customer.id;
      await db.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    try {
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [{
          price: config.stripePremiumPriceId || undefined,
          ...(!config.stripePremiumPriceId ? {
            price_data: {
              currency: 'usd',
              unit_amount: 999, // $9.99/month
              recurring: { interval: 'month' as const },
              product_data: { name: 'Bytspot Premium', description: 'Ad-free experience, priority concierge, exclusive badge' },
            },
          } : {}),
          quantity: 1,
        }],
        metadata: { userId },
        success_url: `${config.frontendUrl}/premium/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.frontendUrl}/premium/cancelled`,
      });
      return { url: session.url };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Stripe error';
      console.error('[subscription] Stripe error:', msg);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg });
    }
  }),

  /** GET /subscription/status → returns current user's premium status */
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUnique({ where: { id: ctx.user.userId }, select: { isPremium: true, membershipTier: true } });
    const membershipTier = user?.membershipTier ?? (user?.isPremium ? 'platinum' : 'green');
    return { isPremium: membershipTier !== 'green', membershipTier };
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

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: 'usd',
          metadata: { fromUserId: ctx.user.userId, toValetId: valetId },
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
  /** admin.platformFee query — the live rate plus recent changes. */
  platformFee: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-platform-fee' }))
    .input(z.object({ scope: z.string().min(1).max(64).default(PARTY_TICKET_FEE_SCOPE) }).default({ scope: PARTY_TICKET_FEE_SCOPE }))
    .query(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.platformFee' });
      const [current, history] = await Promise.all([
        currentPlatformFeeBps(input.scope),
        db.platformFeeSetting.findMany({
          where: { scope: input.scope }, orderBy: { createdAt: 'desc' }, take: 20,
          select: { feeBps: true, note: true, setByUserId: true, createdAt: true },
        }),
      ]);
      return { scope: input.scope, currentFeeBps: current, maxFeeBps: MAX_FEE_BPS, history };
    }),

  /**
   * admin.setPlatformFee mutation — change the market rate without a deploy.
   * Appends rather than updates, so the rate on any past date stays provable,
   * and it only affects parties published after this moment: a live party keeps
   * the rate its host was shown at publish.
   */
  setPlatformFee: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'admin-set-platform-fee' }))
    .input(z.object({
      scope: z.string().min(1).max(64).default(PARTY_TICKET_FEE_SCOPE),
      feeBps: z.number().int().min(0).max(MAX_FEE_BPS),
      note: z.string().max(280).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.setPlatformFee' });
      const previousFeeBps = await currentPlatformFeeBps(input.scope);
      await db.platformFeeSetting.create({
        data: { scope: input.scope, feeBps: input.feeBps, note: input.note ?? null, setByUserId: ctx.user.userId },
      });
      return { scope: input.scope, previousFeeBps, currentFeeBps: input.feeBps, appliesTo: 'parties published from now on' };
    }),

  /** admin.stats query — JWT auth + admin group membership required */
  stats: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'admin-stats' }))
    .query(async ({ ctx }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({ actorId: ctx.user.userId, actorEmail: ctx.user.email, group, action: 'admin.stats' });

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

      const venueIds = topVenues.map((v) => v.venueId);
      const venues = await db.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } });
      const nameMap = Object.fromEntries(venues.map((v) => [v.id, v.name]));
      // Live push reach is registered iOS devices; the retired web-push set
      // counted browsers that nothing has sent to since the PWA was killed.
      const pushDevices = await db.iOSPushDevice.count({ where: { invalidatedAt: null } });

      return {
        totalUsers,
        newSignupsToday: newToday,
        totalCheckins,
        pushDevices,
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

  /** admin.generateInvite mutation — JWT auth + admin group membership required */
  generateInvite: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'admin-generate-invite' }))
    .input(z.object({ count: z.number().min(1).max(50).default(1) }))
    .mutation(async ({ ctx, input }) => {
      const group = assertBytspotAdmin(ctx.user);
      auditAdminAction({
        actorId: ctx.user.userId,
        actorEmail: ctx.user.email,
        group,
        action: 'admin.generateInvite',
        detail: { count: input.count },
      });

      const r = getRedis();
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const codes: string[] = [];

      for (let i = 0; i < input.count; i++) {
        let code = 'BYT-';
        for (let j = 0; j < 6; j++) code += chars[randomInt(chars.length)];
        if (r) {
          await r.set(`invite:${code}`, JSON.stringify({ used: false, createdAt: new Date().toISOString() }), 'EX', 60 * 60 * 24 * 30);
        }
        codes.push(code);
      }

      return { codes, message: `Generated ${codes.length} invite code(s) — valid for 30 days` };
    }),

  /** POST /admin/validate-invite → admin.validateInvite mutation (public — called during signup) */
  validateInvite: publicProcedure
    // Guessing an invite is the same class of attack as guessing a password,
    // so it gets the same budget as auth:login. Unlimited, this was a free
    // oracle over a ~1e9 keyspace whose hits are consumed on validation.
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'admin:validate-invite' }))
    .input(z.object({ code: z.string().max(64) }))
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
  /** Authenticated native registration; APNs token ownership always derives from ctx. */
  registerIosDevice: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'push:register-ios' }))
    .input(z.object({
      token: z.string().max(256),
      environment: z.literal(config.apnsEnvironment),
      bundleId: z.literal(config.apnsBundleId),
    }))
    .mutation(async ({ ctx, input }) => {
      const token = normalizeIosDeviceToken(input.token);
      if (!token) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid iOS device token' });
      }
      await registerIosPushDevice({
        userId: ctx.user.userId,
        token,
        environment: input.environment,
        bundleId: input.bundleId,
      });
      return { success: true };
    }),

  /** Deactivates a device only when it is owned by the authenticated user. */
  unregisterIosDevice: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'push:unregister-ios' }))
    .input(z.object({ token: z.string().max(256) }))
    .mutation(async ({ ctx, input }) => {
      const token = normalizeIosDeviceToken(input.token);
      if (!token) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid iOS device token' });
      }
      const unregistered = await unregisterIosPushDevice(ctx.user.userId, token);
      return { success: true, unregistered };
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
  mobility: mobilityRouter,
  plans: planRouter,
  coffee: coffeeRouter,
});

/** Export type for frontend — this is the magic for end-to-end safety */
export type AppRouter = typeof appRouter;

