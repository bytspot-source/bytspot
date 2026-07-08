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
import { runCrowdSimulation } from '../services/crowdSimulator';
import { userRouter } from './userRouter';
import { socialRouter } from './socialRouter';
import { reviewsRouter } from './reviewsRouter';
import { eventsRouter, mapTmEvent } from './eventsRouter';
import { placesRouter, gpPost, mapPlace, MappedPlace, SEARCH_FIELDS as GP_SEARCH_FIELDS } from './placesRouter';

const NATIVE_BOOTSTRAP_VERSION = 2;
const NATIVE_BOOTSTRAP_PUBLIC_TTL_SECONDS = 20;
const NATIVE_EVENTS_CACHE_SCHEMA_VERSION = 2;
type NativeBootstrapSource = 'live' | 'fallback' | 'mixed';
const nativeWalletProductTypeSchema = z.enum(['parking', 'boutique_stay', 'menu_order', 'airport_transfer']);
type NativeWalletProductType = z.infer<typeof nativeWalletProductTypeSchema>;
const nativeCheckoutInputSchema = z.object({
  spotId: z.string().max(100),
  spotName: z.string().max(200),
  address: z.string().max(500),
  duration: z.number().min(0.5).max(24),
  totalCost: z.number().min(0.01).max(10000),
  productType: nativeWalletProductTypeSchema.optional().default('parking'),
  successPath: z.string().trim().min(1).max(200).optional(),
  cancelPath: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(100).optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
type NativeCheckoutInput = z.infer<typeof nativeCheckoutInputSchema>;
const liveValueInputSchema = z.object({
  productType: z.enum(['parking', 'event_pass', 'menu_order', 'airport_transfer', 'any']).optional().default('any'),
  lat: z.number().finite().min(-90).max(90).optional().default(33.7756),
  lng: z.number().finite().min(-180).max(180).optional().default(-84.3963),
  durationHours: z.number().min(0.5).max(24).optional().default(2),
  maxBudgetCents: z.number().int().min(0).max(1_000_000).optional(),
  maxDistanceMeters: z.number().finite().min(100).max(50_000).optional(),
  limit: z.number().min(1).max(12).optional().default(6),
  strict: z.boolean().optional().default(false),
});
type LiveValueInput = z.infer<typeof liveValueInputSchema>;
type LiveValueSource = 'vendor' | 'google_places' | 'ticketmaster' | 'curated' | 'simulated';
type LiveValueOption = {
  id: string; productType: LiveValueInput['productType']; title: string; providerName: string; source: LiveValueSource;
  listedPriceCents: number | null; estimatedFeesCents: number | null; estimatedTotalCents: number | null; marketReferenceCents: number | null;
  distanceMeters: number | null; availability: string; confidence: number; handoff: 'discover' | 'map' | 'access';
  priceParityScore: number; valueScore: number; eligible: boolean; constraints: { budgetFit: boolean | null; distanceFit: boolean | null; availabilityFit: boolean | null };
  explanation: string[];
};
type ConciergeAction = {
  id: string;
  type: string;
  title: string;
  subtitle: string;
  status: string;
  source: 'server_rules' | 'live_context' | 'fallback';
  handoff: 'discover' | 'map' | 'access' | 'stay';
  productType?: NativeWalletProductType | 'event_pass' | 'provider_contact' | 'live_search';
  metadata?: Record<string, string | number | boolean>;
};

const NATIVE_SPECIAL_DISCOVER_CARDS = [
  { id: 'service-valet-ride', type: 'mobility', title: 'Private Airport Transfer', subtitle: 'Airport pickup, driver review, and authorization-first checkout.', distance: 'Airport', rating: '4.9', icon: 'airplane.departure', verified: true, entryType: 'paid', cta: 'Request Transfer', imageUrl: null, categoryLabel: 'Mobility', badgeText: 'Mobility', metadataLine: 'Bytspot + Elife · Airport', features: ['Review estimate', 'Authorization request', 'My Access status'], vibeScore: 9, availability: 'Estimate + review', membershipRequired: true },
  { id: 'service-group-transport', type: 'mobility', title: 'Group Transport', subtitle: 'Coordinate larger group movement with Concierge.', distance: 'Group', rating: '4.8', icon: 'bus.fill', verified: true, entryType: 'paid', cta: 'Plan Group Ride', imageUrl: null, categoryLabel: 'Mobility', badgeText: 'Mobility', metadataLine: 'Bytspot · Group ride', features: ['Group ETA', 'Concierge support', 'Arrival routing'], vibeScore: 8, availability: 'Request review', membershipRequired: true },
  { id: 'broni-home-taste', type: 'service', title: 'Broni Home Taste', subtitle: 'Ghanaian comfort food, ready for pickup or delivery.', distance: 'Service', rating: '4.9', icon: 'fork.knife', verified: true, entryType: 'paid', cta: 'View Menu', imageUrl: 'https://images.unsplash.com/photo-1604329760661-e71dc83f8f26?auto=format&fit=crop&w=1200&q=88', categoryLabel: 'Dining', badgeText: 'Dining', metadataLine: 'From $21 • Available now', features: ['Jollof + chicken', 'Banku + tilapia', 'Family-style portions'], vibeScore: 9, availability: 'Available now', membershipRequired: true },
  { id: 'gh-akwaaba-pass', type: 'service', title: 'GH Akwaaba Pass', subtitle: 'Ghana matchday access, ready on your phone.', distance: 'Pass', rating: '4.9', icon: 'ticket.fill', verified: true, entryType: 'paid', cta: 'View Pass', imageUrl: 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=1200&q=88', categoryLabel: 'Event Pass', badgeText: 'Event Pass', metadataLine: '$50 • Digital pass ready', features: ['Fast-track entry', 'VIP lounge access', 'Digital pass delivery'], vibeScore: 9, availability: 'Digital pass ready', membershipRequired: true },
];

const NATIVE_FALLBACK_EVENTS = [
  { id: 'fifa-gh', title: 'GH Akwaaba FIFA Matchday', venue: 'Mercedes-Benz Stadium', time: 'Tonight', price: 'Platinum', emoji: '🇬🇭', imageUrl: 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=900&q=80' },
  { id: 'midtown-live', title: 'Midtown Live Lounge', venue: 'Colony Square', time: '8:00 PM', price: 'Free', emoji: '🎶', imageUrl: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=900&q=80' },
];

const NATIVE_FALLBACK_VENUES = [
  { id: 'colony-square', name: 'Colony Square', slug: 'colony-square', address: '1197 Peachtree St NE', lat: 33.7878, lng: -84.3832, category: 'dining', imageUrl: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=900&q=80', entryType: 'free', entryPrice: null, ticketUrl: null, crowd: { level: 2, label: 'Active', waitMins: 5 }, parking: { totalAvailable: 14, spots: [{ name: 'Colony Garage', type: 'garage', available: 14, total: 120, pricePerHr: 8 }] } },
  { id: 'midtown-smart-parking', name: 'Midtown Smart Parking', slug: 'midtown-smart-parking', address: '10th St NE', lat: 33.7819, lng: -84.3847, category: 'parking', imageUrl: null, entryType: 'paid', entryPrice: '$8/hr', ticketUrl: null, crowd: { level: 1, label: 'Easy', waitMins: 0 }, parking: { totalAvailable: 22, spots: [{ name: 'Smart Garage', type: 'garage', available: 22, total: 80, pricePerHr: 8 }] } },
  { id: 'arts-center-access', name: 'Arts Center Access', slug: 'arts-center-access', address: '1280 Peachtree St NE', lat: 33.7892, lng: -84.3849, category: 'entertainment', imageUrl: null, entryType: 'free', entryPrice: null, ticketUrl: null, crowd: { level: 3, label: 'Busy', waitMins: 12 }, parking: { totalAvailable: 8, spots: [{ name: 'Arts Deck', type: 'garage', available: 8, total: 60, pricePerHr: 10 }] } },
];

function nativeIconFor(type: string): string {
  const map: Record<string, string> = { dining: 'fork.knife', nightlife: 'music.note', coffee: 'cup.and.saucer.fill', parking: 'parkingsign.circle.fill', boutique_apartment: 'house.fill', entertainment: 'ticket.fill', fitness: 'figure.mind.and.body', shopping: 'bag.fill', mobility: 'car.side.fill', service: 'checkmark.seal.fill' };
  return map[type] ?? 'mappin.and.ellipse';
}

function nativeLabelFor(type: string): string {
  const map: Record<string, string> = { dining: 'Dining', nightlife: 'Nightlife', coffee: 'Coffee', parking: 'Parking', entertainment: 'Events', fitness: 'Fitness', shopping: 'Shopping', service: 'Services' };
  return map[type] ?? 'Nearby';
}

function nativeDiscoverType(category: string): string {
  const normalized = category.toLowerCase();
  if (normalized.includes('restaurant') || normalized.includes('food') || normalized.includes('dining')) return 'dining';
  if (normalized.includes('bar') || normalized.includes('club') || normalized.includes('nightlife')) return 'nightlife';
  if (normalized.includes('coffee') || normalized.includes('cafe')) return 'coffee';
  if (normalized.includes('parking') || normalized.includes('garage')) return 'parking';
  if (normalized.includes('fitness') || normalized.includes('gym')) return 'fitness';
  if (normalized.includes('shop') || normalized.includes('market')) return 'shopping';
  if (normalized.includes('event') || normalized.includes('entertainment')) return 'entertainment';
  return 'venue';
}

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
            ? { level: v.crowdLevels[0].level, label: v.crowdLevels[0].label, waitMins: v.crowdLevels[0].waitMins, recordedAt: v.crowdLevels[0].recordedAt instanceof Date ? v.crowdLevels[0].recordedAt.toISOString() : String(v.crowdLevels[0].recordedAt) }
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

      const venue = await db.venue.findUnique({ where: { id: venueId } });
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

function mapNativeVenue(v: any) {
  const parkingRows = Array.isArray(v.parking) ? v.parking : [];
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    address: v.address,
    lat: v.lat,
    lng: v.lng,
    category: v.category,
    imageUrl: v.imageUrl ?? null,
    entryType: (v.entryType ?? 'free') as 'free' | 'paid',
    entryPrice: v.entryPrice ?? null,
    ticketUrl: v.ticketUrl ?? null,
    crowd: v.crowdLevels?.[0]
      ? { level: v.crowdLevels[0].level, label: v.crowdLevels[0].label, waitMins: v.crowdLevels[0].waitMins, recordedAt: v.crowdLevels[0].recordedAt instanceof Date ? v.crowdLevels[0].recordedAt.toISOString() : String(v.crowdLevels[0].recordedAt) }
      : v.crowd ?? null,
    parking: {
      totalAvailable: v.parking?.totalAvailable ?? parkingRows.reduce((sum: number, p: any) => sum + (p.available ?? 0), 0),
      spots: v.parking?.spots ?? parkingRows.map((p: any) => ({ name: p.name, type: p.type, available: p.available, total: p.totalSpots ?? p.total, pricePerHr: p.pricePerHr })),
    },
  };
}

function nativeVenueToDiscoverCard(venue: any) {
  const type = nativeDiscoverType(venue.category ?? 'venue');
  const spots = venue.parking?.totalAvailable ?? 0;
  const firstSpot = venue.parking?.spots?.[0];
  const price = firstSpot?.pricePerHr ? `$${firstSpot.pricePerHr}/hr` : venue.entryPrice ?? 'Free';
  const features = [nativeLabelFor(type), venue.crowd?.label ?? 'Open'];
  if (spots > 0) features.push(`${spots} spots`);
  return {
    id: `venue-${venue.id}`,
    type,
    title: venue.name,
    subtitle: venue.address || 'Live venue from bytspot-api',
    distance: '—',
    rating: '4.5',
    icon: nativeIconFor(type),
    verified: false,
    entryType: venue.entryType ?? 'free',
    cta: 'Open details',
    imageUrl: venue.imageUrl ?? null,
    categoryLabel: nativeLabelFor(type),
    badgeText: venue.entryType === 'paid' ? 'PAID ENTRY' : 'FREE ENTRY',
    metadataLine: spots > 0 ? `${price} • ${spots} spots` : price,
    features: features.slice(0, 4),
    vibeScore: Math.min(Math.max((venue.crowd?.level ?? 2) * 2, 1), 10),
    availability: venue.crowd?.label ?? 'Open',
    membershipRequired: false,
  };
}

type LiveValueCandidate = {
  id: string; productType: Exclude<LiveValueInput['productType'], 'any'>; title: string; providerName: string; source: LiveValueSource;
  listedPriceCents: number | null; distanceMeters: number | null; availability: string; available: boolean | null; confidence: number; handoff: 'discover' | 'map' | 'access';
};

function clampScore(value: number) { return Math.round(Math.max(0, Math.min(100, value))); }
function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
function dollars(cents: number | null) { return cents == null ? 'unknown price' : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`; }
function parsePriceCents(value: unknown) {
  const text = String(value ?? '').toLowerCase();
  if (!text || text.includes('see link')) return null;
  if (text.includes('free')) return 0;
  const match = text.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
  return match ? Math.round(Number(match[1]) * 100) : null;
}
function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}
function defaultMarketCents(productType: LiveValueCandidate['productType'], durationHours: number) {
  return ({ parking: Math.round(900 * durationHours), event_pass: 2500, menu_order: 2100, airport_transfer: 9600 } as Record<LiveValueCandidate['productType'], number>)[productType];
}
function scoreLiveValueCandidate(candidate: LiveValueCandidate, constraints: LiveValueInput, peers: LiveValueCandidate[]): LiveValueOption {
  const peerPrices = peers.filter((peer) => peer.productType === candidate.productType).map((peer) => peer.listedPriceCents ?? 0);
  const marketReferenceCents = median(peerPrices) ?? defaultMarketCents(candidate.productType, constraints.durationHours);
  const estimatedFeesCents = candidate.listedPriceCents == null ? null : candidate.listedPriceCents === 0 ? 0 : Math.max(0, Math.round(candidate.listedPriceCents * 0.029) + 30);
  const estimatedTotalCents = candidate.listedPriceCents == null ? null : candidate.listedPriceCents + (estimatedFeesCents ?? 0);
  const priceParityScore = candidate.listedPriceCents == null ? 55 : candidate.listedPriceCents <= marketReferenceCents ? 100 : clampScore(100 - ((candidate.listedPriceCents - marketReferenceCents) / Math.max(marketReferenceCents, 1)) * 100);
  const budgetFit = constraints.maxBudgetCents == null ? null : estimatedTotalCents == null ? (constraints.strict ? false : null) : estimatedTotalCents <= constraints.maxBudgetCents;
  const distanceFit = constraints.maxDistanceMeters == null ? null : candidate.distanceMeters == null ? (constraints.strict ? false : null) : candidate.distanceMeters <= constraints.maxDistanceMeters;
  const availabilityFit = candidate.available;
  const budgetScore = constraints.maxBudgetCents == null ? 78 : estimatedTotalCents == null ? 50 : estimatedTotalCents <= constraints.maxBudgetCents ? 100 : clampScore(100 - ((estimatedTotalCents - constraints.maxBudgetCents) / Math.max(constraints.maxBudgetCents, 1)) * 100);
  const distanceScore = constraints.maxDistanceMeters == null ? 70 : candidate.distanceMeters == null ? 50 : clampScore(100 - (candidate.distanceMeters / Math.max(constraints.maxDistanceMeters, 1)) * 100);
  const availabilityScore = candidate.available == null ? 60 : candidate.available ? 100 : 15;
  const confidenceScore = clampScore(candidate.confidence * 100);
  const valueScore = clampScore(priceParityScore * 0.35 + budgetScore * 0.25 + distanceScore * 0.15 + availabilityScore * 0.15 + confidenceScore * 0.10);
  const eligible = (budgetFit !== false) && (distanceFit !== false) && (availabilityFit !== false);
  const explanation = [
    `${dollars(candidate.listedPriceCents)} listed vs ${dollars(marketReferenceCents)} market reference`,
    estimatedTotalCents == null ? 'Final cost unknown until provider checkout' : `${dollars(estimatedTotalCents)} estimated total with checkout fees`,
    constraints.maxBudgetCents == null ? 'No hard budget constraint applied' : estimatedTotalCents == null ? 'Budget cannot be verified because provider price is unknown' : budgetFit ? 'Within budget constraint' : 'Above budget constraint',
    constraints.maxDistanceMeters == null ? 'No hard distance constraint applied' : candidate.distanceMeters == null ? 'Distance cannot be verified for this provider option' : distanceFit ? `Within ${Math.round(constraints.maxDistanceMeters)}m distance constraint` : `Outside ${Math.round(constraints.maxDistanceMeters)}m distance constraint`,
    `Confidence ${confidenceScore}/100 from ${candidate.source}`,
  ];
  return { ...candidate, estimatedFeesCents, estimatedTotalCents, marketReferenceCents, priceParityScore, valueScore, eligible, constraints: { budgetFit, distanceFit, availabilityFit }, explanation };
}

async function buildLiveValueCandidates(input: LiveValueInput): Promise<LiveValueCandidate[]> {
  const wants = (productType: LiveValueInput['productType']) => input.productType === 'any' || input.productType === productType;
  const origin = { lat: input.lat, lng: input.lng };
  const candidates: LiveValueCandidate[] = [];
  if (wants('parking')) {
    const venues = await db.venue.findMany({ include: { parking: true }, take: 30 }).catch(() => [] as any[]);
    const venueRows = venues.length > 0 ? venues : NATIVE_FALLBACK_VENUES;
    for (const venue of venueRows) {
      const parkingRows = Array.isArray(venue.parking) ? venue.parking : venue.parking?.spots ?? [];
      for (const spot of parkingRows) {
        const pricePerHr = Number(spot.pricePerHr ?? 0);
        candidates.push({
          id: `parking:${spot.id ?? venue.id}:${spot.name ?? 'spot'}`, productType: 'parking', title: spot.name ? `${venue.name} — ${spot.name}` : venue.name,
          providerName: venue.name, source: venues.length > 0 ? 'vendor' : 'curated', listedPriceCents: pricePerHr > 0 ? Math.round(pricePerHr * input.durationHours * 100) : null,
          distanceMeters: typeof venue.lat === 'number' && typeof venue.lng === 'number' ? haversineMeters(origin, { lat: venue.lat, lng: venue.lng }) : null,
          availability: Number(spot.available ?? venue.parking?.totalAvailable ?? 0) > 0 ? `${spot.available ?? venue.parking?.totalAvailable} available` : 'Availability unknown',
          available: Number(spot.available ?? venue.parking?.totalAvailable ?? 0) > 0 ? true : null, confidence: venues.length > 0 ? 0.9 : 0.58, handoff: 'map',
        });
      }
    }
  }
  if (wants('airport_transfer')) {
    candidates.push({ id: 'transfer:byspot-elife', productType: 'airport_transfer', title: 'Private Airport Transfer', providerName: 'Bytspot + Elife', source: 'curated', listedPriceCents: 9600, distanceMeters: null, availability: 'Estimate + review', available: null, confidence: 0.62, handoff: 'discover' });
  }
  if (wants('menu_order')) {
    candidates.push({ id: 'menu:broni-home-taste', productType: 'menu_order', title: 'Broni Home Taste', providerName: 'Broni Home Taste', source: 'curated', listedPriceCents: 2100, distanceMeters: null, availability: 'Available now', available: true, confidence: 0.64, handoff: 'discover' });
  }
  if (wants('event_pass')) {
    const events = await loadNativeEvents(Math.max(input.limit, 6)).catch(() => ({ events: NATIVE_FALLBACK_EVENTS, source: 'fallback' as const }));
    for (const event of events.events) candidates.push({ id: `event:${event.id}`, productType: 'event_pass', title: event.title, providerName: event.venue, source: events.source === 'live' ? 'ticketmaster' : 'curated', listedPriceCents: parsePriceCents(event.price), distanceMeters: null, availability: event.time ?? 'Upcoming', available: true, confidence: events.source === 'live' ? 0.8 : 0.55, handoff: 'discover' });
  }
  return candidates;
}

async function loadNativePublicContent(limit: number) {
  return cached(`native:bootstrap:public:v${NATIVE_BOOTSTRAP_VERSION}:${limit}`, NATIVE_BOOTSTRAP_PUBLIC_TTL_SECONDS, async () => {
    const [venuesResult, eventsResult] = await Promise.allSettled([
      db.venue.findMany({
        include: { crowdLevels: { orderBy: { recordedAt: 'desc' }, take: 1 }, parking: true },
        orderBy: { name: 'asc' },
        take: limit,
      }),
      loadNativeEvents(limit),
    ]);

    const liveVenues = venuesResult.status === 'fulfilled' ? venuesResult.value.map(mapNativeVenue) : [];
    const venues = liveVenues.length > 0 ? liveVenues : NATIVE_FALLBACK_VENUES;
    const eventPayload = eventsResult.status === 'fulfilled' ? eventsResult.value : { events: NATIVE_FALLBACK_EVENTS, source: 'fallback' as const };
    const events = eventPayload.events.length > 0 ? eventPayload.events : NATIVE_FALLBACK_EVENTS;
    const discoverCards = [...NATIVE_SPECIAL_DISCOVER_CARDS, ...venues.slice(0, 8).map(nativeVenueToDiscoverCard)];
    const venuesSource: NativeBootstrapSource = liveVenues.length > 0 ? 'live' : 'fallback';
    const eventsSource: NativeBootstrapSource = eventPayload.source;
    const discoverCardsSource: NativeBootstrapSource = liveVenues.length > 0 ? 'live' : 'fallback';
    const sectionSources = [venuesSource, eventsSource, discoverCardsSource];
    const source: NativeBootstrapSource = sectionSources.every((sectionSource) => sectionSource === 'live')
      ? 'live'
      : sectionSources.every((sectionSource) => sectionSource === 'fallback')
        ? 'fallback'
        : 'mixed';

    return { venues, events, discoverCards, source, sectionSources: { venues: venuesSource, events: eventsSource, discoverCards: discoverCardsSource } };
  });
}

async function loadNativeEvents(limit: number) {
  if (!config.ticketmasterApiKey) return { events: NATIVE_FALLBACK_EVENTS.slice(0, Math.min(limit, NATIVE_FALLBACK_EVENTS.length)), source: 'fallback' as const };
  return cached(`native:events:atl:v${NATIVE_EVENTS_CACHE_SCHEMA_VERSION}:${limit}`, 900, async () => {
    const params = new URLSearchParams({ apikey: config.ticketmasterApiKey, city: 'Atlanta', stateCode: 'GA', size: String(Math.min(limit, 20)), sort: 'date,asc' });
    const res = await fetch(`${TM_BASE}/events.json?${params}`, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return { events: NATIVE_FALLBACK_EVENTS, source: 'fallback' as const };
    const data = (await res.json()) as { _embedded?: { events?: any[] } };
    const events = (data._embedded?.events ?? []).map(mapTmEvent).map((event) => ({ ...event, imageUrl: event.image ?? null })).slice(0, limit);
    return events.length > 0 ? { events, source: 'live' as const } : { events: NATIVE_FALLBACK_EVENTS, source: 'fallback' as const };
  });
}

async function loadNativeAccount(userId: string | undefined) {
  if (!userId) return nativeGuestAccount();
  try {
    const [user, savedSpots, activeBookings] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, phone: true, address: true, birthday: true, vehicles: true, isPremium: true, stripeCustomerId: true, createdAt: true } }),
      db.savedSpot.findMany({ where: { userId }, include: { venue: { select: { id: true, name: true, slug: true, category: true, address: true, lat: true, lng: true, imageUrl: true } } }, orderBy: { savedAt: 'desc' }, take: 4 }).catch(() => []),
      loadNativeWalletLedger(userId, 8),
    ]);
    const vehicles = Array.isArray(user?.vehicles) ? user?.vehicles : [];
    const identityReady = Boolean(user?.email && user?.name && (user?.phone || user?.address));
    const vehicleReady = vehicles.length > 0;
    const hasStripeCustomer = Boolean(user?.stripeCustomerId);
    const hasVerifiedPaymentMethod = false;
    const checks = [identityReady, hasVerifiedPaymentMethod, vehicleReady];
    return {
      mode: 'authenticated' as const,
      user: user ? { id: user.id, email: user.email, name: user.name, isPremium: user.isPremium, createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : String(user.createdAt) } : null,
      profileReadiness: readiness(checks, ['identity', 'payment', 'vehicle']),
      paymentReadiness: { ready: hasVerifiedPaymentMethod, hasStripeCustomer, savedMethodCount: 0, note: hasStripeCustomer ? 'Stripe customer exists; saved payment method verification is not wired yet.' : 'No Stripe customer on file.' },
      savedPlaces: savedSpots.map((spot: any) => ({ id: spot.id, venueId: spot.venueId, title: spot.venue?.name ?? 'Saved place', subtitle: spot.venue?.address ?? '', category: spot.venue?.category ?? 'venue', imageUrl: spot.venue?.imageUrl ?? null, savedAt: spot.savedAt instanceof Date ? spot.savedAt.toISOString() : String(spot.savedAt) })),
      activeBookings,
    };
  } catch {
    return nativeGuestAccount('authenticated_unavailable');
  }
}

function nativeGuestAccount(mode: 'guest' | 'authenticated_unavailable' = 'guest') {
  return { mode, user: null, profileReadiness: readiness([false, false, false], ['identity', 'payment', 'vehicle']), paymentReadiness: { ready: false, hasStripeCustomer: false, savedMethodCount: 0 }, savedPlaces: [] as any[], activeBookings: { source: 'device_local' as const, count: 0, items: [] as any[], note: 'Sign in to sync account state; native wallet entries remain on this device.' } };
}

function readiness(checks: boolean[], names: string[]) {
  return { completed: checks.filter(Boolean).length, total: checks.length, checks: names.map((name, index) => ({ name, ready: checks[index] })), missing: names.filter((_, index) => !checks[index]) };
}

const nativeWalletActions = [{ id: 'open_access', title: 'Open My Access', type: 'native_panel', target: 'access' }];

function nativeWalletDate(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function nativeWalletMetadataValue(metadata: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (value && value.trim()) return value;
  }
  return undefined;
}

function nativeWalletProviderState(productType: NativeWalletProductType, metadata: Record<string, string>) {
  if (productType === 'parking') return 'payment_pending';
  if (productType === 'menu_order') return 'stripe_checkout_pending';
  if (productType === 'boutique_stay') return 'host_review_pending';
  return nativeWalletMetadataValue(metadata, ['requestedStatus', 'providerState']) ?? 'pending_authorization';
}

function nativeWalletPaymentState(productType: NativeWalletProductType, metadata: Record<string, string>) {
  const captureMode = metadata.captureMode ?? '';
  if (productType === 'boutique_stay' || productType === 'airport_transfer' || captureMode.startsWith('manual_')) return 'authorization_pending';
  return 'checkout_pending';
}

function nativeWalletTitle(productType: NativeWalletProductType) {
  return ({ parking: 'Parking Reserved', boutique_stay: 'Boutique Stay Request', menu_order: 'Menu Order', airport_transfer: 'Airport Transfer' } as Record<NativeWalletProductType, string>)[productType];
}

function mapNativeWalletLedgerEntry(entry: any) {
  const actions = Array.isArray(entry.actions) ? entry.actions : nativeWalletActions;
  return {
    id: entry.id,
    productType: entry.productType,
    title: entry.title,
    subtitle: entry.subtitle ?? null,
    venueName: entry.venueName ?? null,
    providerName: entry.providerName ?? null,
    windowLabel: entry.windowLabel ?? null,
    paymentState: entry.paymentState,
    providerState: entry.providerState,
    reservationReference: entry.reservationReference ?? null,
    amountCents: entry.amountCents ?? null,
    currency: entry.currency ?? 'usd',
    source: entry.source ?? 'server',
    receiptUrl: entry.receiptUrl ?? null,
    actions,
    metadata: entry.metadata ?? {},
    createdAt: nativeWalletDate(entry.createdAt) ?? new Date().toISOString(),
    updatedAt: nativeWalletDate(entry.updatedAt) ?? nativeWalletDate(entry.createdAt) ?? new Date().toISOString(),
  };
}

async function loadNativeWalletLedger(userId: string, limit = 12) {
  try {
    const entries = await db.walletLedgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
    return {
      source: 'server' as const,
      count: entries.length,
      items: entries.map(mapNativeWalletLedgerEntry),
      note: entries.length > 0 ? 'Server wallet ledger is authoritative for signed-in users.' : 'No server wallet entries yet; native wallet can show device-local fallback entries.',
    };
  } catch {
    return { source: 'unavailable' as const, count: 0, items: [] as any[], note: 'Server wallet ledger unavailable; native wallet can show device-local fallback entries.' };
  }
}

async function createNativeWalletLedgerFromCheckout(userId: string, input: NativeCheckoutInput, amountCents: number, session: { id?: string | null; payment_intent?: string | { id?: string } | null }, checkoutMetadata: Record<string, string>) {
  const productType = input.productType;
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  const venueName = nativeWalletMetadataValue(checkoutMetadata, ['venueName', 'spotName']) ?? input.spotName;
  const providerName = productType === 'airport_transfer' ? 'Elife Transfer' : 'Bytspot';
  const windowLabel = nativeWalletMetadataValue(checkoutMetadata, ['accessWindowLabel', 'pickupTimeLabel', 'nightsLabel', 'fulfillmentLabel']) ?? `${input.duration}h window`;
  const reservationReference = nativeWalletMetadataValue(checkoutMetadata, ['reservationReference', 'reservationCode', 'requestCode', 'orderCode', 'quoteId']) ?? session.id ?? undefined;
  return db.walletLedgerEntry.create({
    data: {
      userId,
      productType,
      title: nativeWalletTitle(productType),
      subtitle: input.address,
      venueName,
      providerName,
      windowLabel,
      paymentState: nativeWalletPaymentState(productType, checkoutMetadata),
      providerState: nativeWalletProviderState(productType, checkoutMetadata),
      reservationReference,
      amountCents,
      currency: 'usd',
      source: 'server_checkout',
      actions: nativeWalletActions,
      metadata: { ...checkoutMetadata, stripeCheckoutSessionId: session.id ?? null, stripePaymentIntentId: paymentIntentId },
    },
  });
}

/**
 * ── Native bootstrap sub-router ─────────────────────────────
 */
const nativeRouter = router({
  /** /trpc/native.bootstrap → public shell data + optional signed-in account readiness */
  bootstrap: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(30).optional().default(12) }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 12;
      const generatedAt = new Date().toISOString();
      const [content, account] = await Promise.all([
        loadNativePublicContent(limit),
        loadNativeAccount(ctx.user?.userId),
      ]);
      return {
        version: NATIVE_BOOTSTRAP_VERSION,
        generatedAt,
        freshness: { ttlSeconds: NATIVE_BOOTSTRAP_PUBLIC_TTL_SECONDS, publicContentSource: content.source, sections: content.sectionSources },
        content: { venues: content.venues, discoverCards: content.discoverCards, events: content.events, source: content.source },
        account,
        concierge: { city: 'Midtown', starterPrompts: ['Find parking nearby', 'Check stay dates', 'Access my booking', 'What’s open now?'] },
        featureFlags: { nativeBootstrap: true, appClipHandoff: true, stripeManualAuthorization: true, serverArrivalLedger: true },
      };
    }),
  /** /trpc/native.walletLedger → server-authoritative Profile/My Access ledger. Mutation keeps native POST transport compatible. */
  walletLedger: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(50).optional().default(20) }).optional())
    .mutation(async ({ ctx, input }) => loadNativeWalletLedger(ctx.user.userId, input?.limit ?? 20)),
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
 * ── Live Provider Value sub-router ─────────────────────
 * Scores low-cost live/curated provider options for constrained best value.
 */
const liveRouter = router({
  bestValue: publicProcedure
    .input(liveValueInputSchema.optional())
    .query(async ({ input }) => {
      const constraints = liveValueInputSchema.parse(input ?? {});
      const cacheKey = `live:bestValue:v1:${constraints.productType}:${constraints.lat.toFixed(3)}:${constraints.lng.toFixed(3)}:${constraints.durationHours}:${constraints.maxBudgetCents ?? 'any'}:${constraints.maxDistanceMeters ?? 'any'}:${constraints.limit}:${constraints.strict}`;
      return cached(cacheKey, 45, async () => {
        const candidates = await buildLiveValueCandidates(constraints);
        const scored = candidates.map((candidate) => scoreLiveValueCandidate(candidate, constraints, candidates));
        const ranked = scored
          .filter((option) => !constraints.strict || option.eligible)
          .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.valueScore - a.valueScore || (a.estimatedTotalCents ?? Number.MAX_SAFE_INTEGER) - (b.estimatedTotalCents ?? Number.MAX_SAFE_INTEGER));
        const returned = ranked.slice(0, constraints.limit);
        const source = returned.some((option) => option.source === 'vendor' || option.source === 'ticketmaster' || option.source === 'google_places')
          ? returned.every((option) => option.source === 'vendor' || option.source === 'ticketmaster' || option.source === 'google_places') ? 'live' : 'mixed'
          : 'curated';
        return { generatedAt: new Date().toISOString(), constraints, source, bestValue: returned[0] ?? null, options: returned };
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

function latestUserMessage(messages: { role: 'user' | 'assistant'; content: string }[]) {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? messages[messages.length - 1]?.content ?? '';
}

function pushConciergeAction(actions: ConciergeAction[], action: ConciergeAction) {
  if (!actions.some((existing) => existing.id === action.id)) actions.push(action);
}

function conciergeActionPriority(action: ConciergeAction, query: string) {
  if (action.id === 'provider-contact') return 0;
  if (action.id === 'open-my-access' && /access|booking|reservation|receipt|wallet|my access/.test(query)) return 1;
  if (action.type === 'live_option_search') return 4;
  return 2;
}

function planConciergeActions(query: string, liveCtx?: LiveContext): { actions: ConciergeAction[]; escalationRequired: boolean } {
  const q = query.toLowerCase();
  const actions: ConciergeAction[] = [];
  const livePlaceCount = liveCtx?.nearbyPlaces?.length ?? 0;
  const liveEventCount = liveCtx?.events?.length ?? 0;

  if (/airport|transfer|ride|pickup|drop[- ]?off|chauffeur|valet/.test(q)) {
    pushConciergeAction(actions, { id: 'request-transfer', type: 'transfer_booking', title: 'Request airport transfer', subtitle: 'Review estimate, vehicle fit, and authorization before any capture.', status: 'authorization_review', source: 'server_rules', handoff: 'discover', productType: 'airport_transfer', metadata: { captureMode: 'manual_authorization' } });
  }
  if (/parking|park|garage|spot|arrive/.test(q)) {
    pushConciergeAction(actions, { id: 'compare-parking', type: 'live_option_search', title: 'Compare parking nearby', subtitle: livePlaceCount > 0 ? `${livePlaceCount} live nearby places available for context.` : 'Open Map with curated parking and venue pins.', status: livePlaceCount > 0 ? 'live_context' : 'curated_context', source: livePlaceCount > 0 ? 'live_context' : 'server_rules', handoff: 'map', productType: 'live_search' });
  }
  if (/stay|suite|hotel|host|availability|check dates|boutique/.test(q)) {
    pushConciergeAction(actions, { id: 'check-stay-dates', type: 'host_review', title: 'Check stay dates', subtitle: 'Host availability is reviewed before payment capture.', status: 'host_review_required', source: 'server_rules', handoff: 'stay', productType: 'boutique_stay', metadata: { captureMode: 'manual_after_host_confirm' } });
  }
  if (/pass|ticket|event|fifa|akwaaba|game|match/.test(q)) {
    pushConciergeAction(actions, { id: 'view-event-pass', type: 'event_pass', title: 'View event and pass options', subtitle: liveEventCount > 0 ? `${liveEventCount} live event options found.` : 'Open Discover for curated pass options.', status: liveEventCount > 0 ? 'live_options' : 'curated_options', source: liveEventCount > 0 ? 'live_context' : 'server_rules', handoff: 'discover', productType: 'event_pass' });
  }
  if (/food|menu|order|broni|dining|chef|catering/.test(q)) {
    pushConciergeAction(actions, { id: 'open-menu-order', type: 'menu_order', title: 'View menu or order options', subtitle: 'Open verified service cards; checkout still confirms details first.', status: 'review_before_checkout', source: 'server_rules', handoff: 'discover', productType: 'menu_order' });
  }
  if (/access|booking|reservation|receipt|wallet|my access/.test(q)) {
    pushConciergeAction(actions, { id: 'open-my-access', type: 'wallet_review', title: 'Open My Access', subtitle: 'Review reservations, payment state, references, and receipts.', status: 'server_ledger', source: 'server_rules', handoff: 'access' });
  }
  if (/provider|contact|human|specialist|refund|vip|support|concierge/.test(q)) {
    pushConciergeAction(actions, { id: 'provider-contact', type: 'provider_contact', title: 'Review provider contact options', subtitle: 'Open My Access to prepare provider coordination with your wallet/request context.', status: 'concierge_review', source: 'server_rules', handoff: 'access', productType: 'provider_contact' });
  }
  if (/open|nearby|tonight|happening|recommend|options|search/.test(q)) {
    pushConciergeAction(actions, { id: 'live-search', type: 'live_option_search', title: 'Search live nearby options', subtitle: livePlaceCount + liveEventCount > 0 ? `${livePlaceCount} places · ${liveEventCount} events in live context.` : 'Open Discover and Map with curated fallbacks.', status: livePlaceCount + liveEventCount > 0 ? 'live_context' : 'curated_context', source: livePlaceCount + liveEventCount > 0 ? 'live_context' : 'fallback', handoff: 'discover', productType: 'live_search' });
  }

  if (actions.length === 0) {
    pushConciergeAction(actions, { id: 'open-discover', type: 'live_option_search', title: 'Open Discover', subtitle: 'Browse nearby places, services, passes, and mobility options.', status: 'curated_context', source: 'fallback', handoff: 'discover', productType: 'live_search' });
    pushConciergeAction(actions, { id: 'show-map', type: 'live_option_search', title: 'Show on Map', subtitle: 'Compare verified zones, parking, and nearby access points.', status: 'curated_context', source: 'fallback', handoff: 'map', productType: 'live_search' });
  }

  const escalationRequired = /human|specialist|refund|vip|host|provider|contact|support|concierge|catering|private chef/.test(q);
  const prioritizedActions = actions
    .map((action, index) => ({ action, index, priority: conciergeActionPriority(action, q) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ action }) => action);
  return { actions: prioritizedActions.slice(0, 4), escalationRequired };
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

        const actionPlan = planConciergeActions(latestUserMessage(messages), liveCtx);
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
          actions: actionPlan.actions,
          escalationRequired: actionPlan.escalationRequired,
          actionSource: 'server_rules' as const,
        };
      } catch (err: any) {
        console.error('[Concierge] OpenAI error:', err?.message);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'AI concierge temporarily unavailable' });
      }
    }),
  /** POST /concierge/actions → deterministic Concierge action plan without AI completion */
  actions: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'concierge:actions' }))
    .input(z.object({ query: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ input }) => {
      const liveCtx = await fetchLiveContext();
      const actionPlan = planConciergeActions(input.query, liveCtx);
      return { ...actionPlan, actionSource: 'server_rules' as const, liveContext: { placeCount: liveCtx.nearbyPlaces.length, eventCount: liveCtx.events.length } };
    }),
});

/**
 * ── Payments (Stripe) sub-router ──────────────────────
 */
const paymentsRouter = router({
  /** POST /payments/checkout → payments.checkout mutation (auth required — handles $$) */
  checkout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'payments:checkout' }))
    .input(nativeCheckoutInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey) {
        return {
          url: null as string | null,
          demoMode: true,
          message: 'Stripe not configured — set STRIPE_SECRET_KEY env var on Render',
        };
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const { spotName, address, duration, totalCost, spotId, productType, successPath, cancelPath, source } = input;
      const amountCents = Math.round(totalCost * 100);

      if (!spotName || !totalCost) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'spotName and totalCost are required' });
      }

      try {
        const safePath = (path: string | undefined, fallback: string) => {
          if (!path || !path.startsWith('/') || path.startsWith('//')) return fallback;
          return path;
        };
        const checkoutSuccessUrl = (path: string) => `${config.frontendUrl}${path}${path.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;
        const productNames: Record<NativeWalletProductType, string> = {
          parking: `Parking — ${spotName}`,
          boutique_stay: `Boutique Stay — ${spotName}`,
          menu_order: `Menu Order — ${spotName}`,
          airport_transfer: `Airport Transfer — ${spotName}`,
        };
        const productDescriptions: Record<NativeWalletProductType, string> = {
          parking: `${duration}h at ${address}`,
          boutique_stay: `Stay authorization for ${address}`,
          menu_order: `Order checkout for ${address}`,
          airport_transfer: `Transfer authorization for ${address}`,
        };
        const flow = productType === 'parking' ? 'parking.checkout' : `native.${productType}.checkout`;
        const nativeMetadata = Object.fromEntries(
          Object.entries(input.metadata ?? {})
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        );
        const checkoutMetadata = {
          ...nativeMetadata,
          flow,
          source: nativeMetadata.source ?? source ?? flow,
          productType,
          spotId: spotId || '',
          duration: String(duration),
          amountCents: String(amountCents),
        };
        const shouldManualCapture = productType === 'boutique_stay' || productType === 'airport_transfer' || String(nativeMetadata.captureMode ?? '').startsWith('manual_');
        const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData = {
          metadata: checkoutMetadata,
        };
        if (shouldManualCapture) paymentIntentData.capture_method = 'manual';

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          line_items: [{
            price_data: {
              currency: 'usd',
              unit_amount: amountCents,
              product_data: {
                name: productNames[productType],
                description: productDescriptions[productType],
              },
            },
            quantity: 1,
          }],
          metadata: checkoutMetadata,
          payment_intent_data: paymentIntentData,
          success_url: checkoutSuccessUrl(safePath(successPath, '/parking/success')),
          cancel_url: `${config.frontendUrl}${safePath(cancelPath, '/parking/cancelled')}`,
        });

        const ledgerEntry = await createNativeWalletLedgerFromCheckout(ctx.user.userId, input, amountCents, session, checkoutMetadata).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'wallet ledger persistence failed';
          console.error('[payments] Wallet ledger create failed:', msg);
          return null;
        });

        return { url: session.url, ledgerEntryId: ledgerEntry?.id ?? null };
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
    let user = await db.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true, email: true, isPremium: true } });
    if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    if (user.isPremium) return { url: null as string | null, demoMode: false, message: 'Already premium' };

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
    const user = await db.user.findUnique({ where: { id: ctx.user.userId }, select: { isPremium: true } });
    return { isPremium: user?.isPremium ?? false };
  }),

  /** POST /subscription/webhook → handles Stripe webhook events for subscriptions */
  webhook: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 50, label: 'subscription:webhook' }))
    .input(z.object({
      type: z.string().max(100),
      data: z.object({
        object: z.object({
          metadata: z.object({ userId: z.string().max(100).optional() }).optional(),
          mode: z.string().max(50).optional(),
          customer: z.string().max(100).optional(),
        }).passthrough().optional(),
      }).passthrough(),
    }))
    .mutation(async ({ input }) => {
      const { type, data } = input;
      if (type === 'checkout.session.completed') {
        const userId = data?.object?.metadata?.userId;
        if (userId && data?.object?.mode === 'subscription') {
          await db.user.update({ where: { id: userId }, data: { isPremium: true } });
          console.log(`[subscription] User ${userId} upgraded to Premium`);
        }
      } else if (type === 'customer.subscription.deleted') {
        const customerId = data?.object?.customer;
        if (customerId) {
          await db.user.updateMany({ where: { stripeCustomerId: customerId }, data: { isPremium: false } });
          console.log(`[subscription] Customer ${customerId} subscription cancelled`);
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
  native: nativeRouter,
  venues: venuesRouter,
  rides: ridesRouter,
  live: liveRouter,
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
});

/** Export type for frontend — this is the magic for end-to-end safety */
export type AppRouter = typeof appRouter;

