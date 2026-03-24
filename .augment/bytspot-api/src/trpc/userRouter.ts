/**
 * User sub-router — Phase 1: Core User Data
 * Handles points, achievements, check-in history, saved spots, preferences.
 */
import { z } from 'zod';
import { router, protectedProcedure } from './trpc';
import { db } from '../lib/db';

// ─── Achievement Definitions (static catalog) ────────────────────────
export const ACHIEVEMENTS = [
  { id: 'first_checkin', name: 'First Steps', description: 'Check in to your first venue', icon: '👣', category: 'discovery', requirement: 1, reward: 50, rarity: 'common' },
  { id: 'checkin_5', name: 'Regular', description: 'Check in 5 times', icon: '🔄', category: 'discovery', requirement: 5, reward: 100, rarity: 'common' },
  { id: 'checkin_25', name: 'Explorer', description: 'Check in 25 times', icon: '🧭', category: 'discovery', requirement: 25, reward: 250, rarity: 'rare' },
  { id: 'checkin_100', name: 'Veteran', description: 'Check in 100 times', icon: '🏆', category: 'discovery', requirement: 100, reward: 500, rarity: 'epic' },
  { id: 'night_owl_10', name: 'Night Owl', description: 'Check in after 10 PM ten times', icon: '🦉', category: 'engagement', requirement: 10, reward: 200, rarity: 'rare' },
  { id: 'social_5', name: 'Social Butterfly', description: 'Follow 5 users', icon: '🦋', category: 'social', requirement: 5, reward: 150, rarity: 'common' },
  { id: 'save_10', name: 'Collector', description: 'Save 10 spots', icon: '📌', category: 'discovery', requirement: 10, reward: 150, rarity: 'common' },
  { id: 'streak_7', name: 'Week Warrior', description: '7-day check-in streak', icon: '🔥', category: 'engagement', requirement: 7, reward: 300, rarity: 'rare' },
  { id: 'review_5', name: 'Critic', description: 'Leave 5 reviews', icon: '⭐', category: 'engagement', requirement: 5, reward: 200, rarity: 'common' },
  { id: 'unique_venues_10', name: 'Wanderer', description: 'Visit 10 unique venues', icon: '🗺️', category: 'discovery', requirement: 10, reward: 250, rarity: 'rare' },
] as const;

// ─── Tier thresholds ─────────────────────────────────────────────────
const TIER_THRESHOLDS = [
  { level: 'platinum', min: 5000 },
  { level: 'gold', min: 2000 },
  { level: 'silver', min: 500 },
  { level: 'bronze', min: 0 },
] as const;

function getTier(lifetime: number) {
  return TIER_THRESHOLDS.find((t) => lifetime >= t.min) ?? TIER_THRESHOLDS[3];
}

// ─── Points sub-router ───────────────────────────────────────────────
const pointsRouter = router({
  /** Get user's current points balance + tier */
  get: protectedProcedure.query(async ({ ctx }) => {
    const txns = await db.pointTransaction.findMany({
      where: { userId: ctx.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    const earned = txns.filter((t) => t.type !== 'spend').reduce((s, t) => s + t.amount, 0);
    const spent = txns.filter((t) => t.type === 'spend').reduce((s, t) => s + Math.abs(t.amount), 0);
    const total = earned - spent;
    const tier = getTier(earned);
    return { total, lifetime: earned, spent, tier: tier.level };
  }),

  /** Point transaction history (paginated) */
  history: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).optional().default(20), cursor: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const txns = await db.pointTransaction.findMany({
        where: { userId: ctx.user.userId },
        orderBy: { createdAt: 'desc' },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = txns.length > input.limit;
      const items = hasMore ? txns.slice(0, -1) : txns;
      return { items, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
    }),
});

// ─── Achievements sub-router ─────────────────────────────────────────
const achievementsRouter = router({
  /** List all achievements with user's unlock status */
  list: protectedProcedure.query(async ({ ctx }) => {
    const unlocked = await db.userAchievement.findMany({ where: { userId: ctx.user.userId } });
    const unlockedMap = new Map(unlocked.map((a) => [a.achievementId, a.unlockedAt]));
    return ACHIEVEMENTS.map((a) => ({
      ...a,
      unlocked: unlockedMap.has(a.id),
      unlockedAt: unlockedMap.get(a.id) ?? null,
    }));
  }),
});

// ─── Check-in history sub-router ─────────────────────────────────────
const checkinsRouter = router({
  /** List user's check-in history */
  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).optional().default(20), cursor: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await db.checkIn.findMany({
        where: { userId: ctx.user.userId },
        include: { venue: { select: { name: true, category: true, slug: true } } },
        orderBy: { createdAt: 'desc' },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, -1) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
    }),

  /** Get total check-in count */
  count: protectedProcedure.query(async ({ ctx }) => {
    return db.checkIn.count({ where: { userId: ctx.user.userId } });
  }),
});

// ─── Saved Spots sub-router ──────────────────────────────────────────
const savedSpotsRouter = router({
  /** List user's saved spots */
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.savedSpot.findMany({
      where: { userId: ctx.user.userId },
      include: { venue: { select: { id: true, name: true, slug: true, category: true, address: true, lat: true, lng: true, imageUrl: true } } },
      orderBy: { savedAt: 'desc' },
    });
  }),

  /** Save a venue */
  save: protectedProcedure
    .input(z.object({ venueId: z.string(), notes: z.string().optional(), tags: z.array(z.string()).optional() }))
    .mutation(async ({ ctx, input }) => {
      return db.savedSpot.upsert({
        where: { userId_venueId: { userId: ctx.user.userId, venueId: input.venueId } },
        create: { userId: ctx.user.userId, venueId: input.venueId, notes: input.notes, tags: input.tags ?? [] },
        update: { notes: input.notes, tags: input.tags ?? [] },
      });
    }),

  /** Remove a saved spot */
  remove: protectedProcedure
    .input(z.object({ venueId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await db.savedSpot.deleteMany({ where: { userId: ctx.user.userId, venueId: input.venueId } });
      return { success: true };
    }),

  /** List user's collections */
  collections: protectedProcedure.query(async ({ ctx }) => {
    return db.spotCollection.findMany({
      where: { userId: ctx.user.userId },
      include: { items: { include: { savedSpot: { include: { venue: { select: { id: true, name: true, slug: true, imageUrl: true } } } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }),

  /** Create a collection */
  createCollection: protectedProcedure
    .input(z.object({ name: z.string(), description: z.string().optional(), icon: z.string().optional(), color: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { name, description, icon, color } = input;
      return db.spotCollection.create({ data: { userId: ctx.user.userId, name, description, icon, color } });
    }),

  /** Add a saved spot to a collection */
  addToCollection: protectedProcedure
    .input(z.object({ collectionId: z.string(), savedSpotId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const col = await db.spotCollection.findFirst({ where: { id: input.collectionId, userId: ctx.user.userId } });
      if (!col) throw new (await import('@trpc/server')).TRPCError({ code: 'NOT_FOUND', message: 'Collection not found' });
      return db.spotCollectionItem.upsert({
        where: { collectionId_savedSpotId: { collectionId: input.collectionId, savedSpotId: input.savedSpotId } },
        create: { collectionId: input.collectionId, savedSpotId: input.savedSpotId },
        update: {},
      });
    }),
});

// ─── Preferences sub-router ─────────────────────────────────────────
const preferencesRouter = router({
  /** Get user preferences */
  get: protectedProcedure.query(async ({ ctx }) => {
    const pref = await db.userPreference.findUnique({ where: { userId: ctx.user.userId } });
    return pref ?? { interests: [], vibes: [], cuisines: [], parking: null, behavior: null };
  }),

  /** Update user preferences */
  update: protectedProcedure
    .input(z.object({
      interests: z.array(z.string()).optional(),
      vibes: z.array(z.string()).optional(),
      cuisines: z.array(z.string()).optional(),
      parking: z.object({ covered: z.boolean().optional(), evCharging: z.boolean().optional(), security: z.enum(['basic', 'standard', 'premium']).optional() }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return db.userPreference.upsert({
        where: { userId: ctx.user.userId },
        create: { userId: ctx.user.userId, ...input },
        update: input,
      });
    }),

  /** Track user behavior (category click, venue visit, etc.) */
  trackBehavior: protectedProcedure
    .input(z.object({ action: z.string(), category: z.string().optional(), venueId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const pref = await db.userPreference.findUnique({ where: { userId: ctx.user.userId } });
      const behavior = (pref?.behavior as Record<string, any>) ?? {};
      // Increment category click count
      if (input.category) {
        behavior.categoryClicks = behavior.categoryClicks ?? {};
        behavior.categoryClicks[input.category] = (behavior.categoryClicks[input.category] ?? 0) + 1;
      }
      // Track venue visit
      if (input.venueId) {
        behavior.visitCounts = behavior.visitCounts ?? {};
        behavior.visitCounts[input.venueId] = (behavior.visitCounts[input.venueId] ?? 0) + 1;
      }
      behavior.lastAction = input.action;
      behavior.lastActionAt = new Date().toISOString();

      await db.userPreference.upsert({
        where: { userId: ctx.user.userId },
        create: { userId: ctx.user.userId, behavior },
        update: { behavior },
      });
      return { ok: true };
    }),
});

// ─── Profile sub-router ─────────────────────────────────────────────
const profileRouter = router({
  /** Get user profile (personal info) */
  get: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUnique({
      where: { id: ctx.user.userId },
      select: { id: true, email: true, name: true, phone: true, profileImage: true, address: true, birthday: true, createdAt: true },
    });
    if (!user) throw new (await import('@trpc/server')).TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    return user;
  }),

  /** Update user profile */
  update: protectedProcedure
    .input(z.object({
      name: z.string().max(100).optional(),
      phone: z.string().max(20).optional(),
      address: z.string().max(200).optional(),
      birthday: z.string().max(20).optional(),
      profileImage: z.string().max(500_000).optional(), // base64 data URL can be large
    }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.update({
        where: { id: ctx.user.userId },
        data: input,
        select: { id: true, email: true, name: true, phone: true, profileImage: true, address: true, birthday: true },
      });
      return user;
    }),
});

// ─── Vehicles sub-router ────────────────────────────────────────────
const vehicleSchema = z.object({
  id: z.string(),
  type: z.enum(['sedan', 'suv', 'truck', 'ev', 'motorcycle']),
  make: z.string().max(50),
  model: z.string().max(50),
  year: z.number().int().min(1900).max(2100),
  color: z.string().max(30),
  licensePlate: z.string().max(15),
  photo: z.string().optional(),
  vin: z.string().max(17).optional(),
  transmissionType: z.enum(['automatic', 'manual', 'ev']),
  trunkCategory: z.enum(['full', 'compact', 'frunk_only', 'none']),
});

const vehiclesRouter = router({
  /** List user's saved vehicles */
  list: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUnique({
      where: { id: ctx.user.userId },
      select: { vehicles: true },
    });
    return (user?.vehicles as any[]) ?? [];
  }),

  /** Add a vehicle */
  add: protectedProcedure
    .input(vehicleSchema.omit({ id: true }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUnique({ where: { id: ctx.user.userId }, select: { vehicles: true } });
      const vehicles = (user?.vehicles as any[]) ?? [];
      const newVehicle = { id: `v_${Date.now()}`, ...input };
      vehicles.push(newVehicle);
      await db.user.update({ where: { id: ctx.user.userId }, data: { vehicles } });
      return newVehicle;
    }),

  /** Update a vehicle */
  update: protectedProcedure
    .input(vehicleSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUnique({ where: { id: ctx.user.userId }, select: { vehicles: true } });
      const vehicles = (user?.vehicles as any[]) ?? [];
      const idx = vehicles.findIndex((v: any) => v.id === input.id);
      if (idx === -1) throw new (await import('@trpc/server')).TRPCError({ code: 'NOT_FOUND', message: 'Vehicle not found' });
      vehicles[idx] = input;
      await db.user.update({ where: { id: ctx.user.userId }, data: { vehicles } });
      return input;
    }),

  /** Remove a vehicle */
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUnique({ where: { id: ctx.user.userId }, select: { vehicles: true } });
      const vehicles = ((user?.vehicles as any[]) ?? []).filter((v: any) => v.id !== input.id);
      await db.user.update({ where: { id: ctx.user.userId }, data: { vehicles } });
      return { success: true };
    }),
});

// ─── Compose user router ────────────────────────────────────────────
export const userRouter = router({
  points: pointsRouter,
  achievements: achievementsRouter,
  checkins: checkinsRouter,
  savedSpots: savedSpotsRouter,
  preferences: preferencesRouter,
  profile: profileRouter,
  vehicles: vehiclesRouter,
});

