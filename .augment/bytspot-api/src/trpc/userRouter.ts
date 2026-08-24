/**
 * User sub-router — Phase 1: Core User Data
 * Handles points, achievements, check-in history, saved spots, preferences.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from './trpc';
import { db } from '../lib/db';
import {
  DELETION_GRACE_DAYS,
  isWithinGracePeriod,
  purgeDateFrom,
  restoreSessions,
  revokeSessions,
} from '../services/accountDeletion';
import {
  ACTIVE_WINDOW_MS,
  activeCount,
  cellFor,
  memberCount,
  recordActive,
  resolveSummary,
} from '../services/presence';

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
      // Identity hashes are refreshed only from auth-verified identifiers
      // (signup email). The free-form profile phone is intentionally never
      // hashed — see services/userIdentityHashes.ts.
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

/**
 * Rows, not a JSON array. Each mutation now writes only the vehicle it names,
 * so two concurrent adds no longer overwrite each other with a stale copy of
 * the whole list, and an id identifies exactly one vehicle instead of every
 * vehicle created in the same millisecond.
 */
const vehicleSelect = {
  id: true,
  type: true,
  make: true,
  model: true,
  year: true,
  color: true,
  licensePlate: true,
  photo: true,
  vin: true,
  transmissionType: true,
  trunkCategory: true,
} as const;

const vehiclesRouter = router({
  /** List user's saved vehicles */
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.vehicle.findMany({
      where: { userId: ctx.user.userId },
      select: vehicleSelect,
      orderBy: { createdAt: 'asc' },
    });
  }),

  /** Add a vehicle */
  add: protectedProcedure
    .input(vehicleSchema.omit({ id: true }))
    .mutation(async ({ ctx, input }) => {
      return db.vehicle.create({
        data: { ...input, userId: ctx.user.userId },
        select: vehicleSelect,
      });
    }),

  /** Update a vehicle */
  update: protectedProcedure
    .input(vehicleSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      // Scoped by userId as well as id, so a caller holding another member's
      // vehicle id gets NOT_FOUND rather than editing it. `updateMany` is used
      // for that scoping: `update` takes the primary key alone.
      const { count } = await db.vehicle.updateMany({
        where: { id, userId: ctx.user.userId },
        data: fields,
      });
      if (count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vehicle not found' });
      return input;
    }),

  /** Remove a vehicle */
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Ownership-scoped for the same reason as update. Removing something
      // already gone stays a success: the caller's intent is satisfied.
      await db.vehicle.deleteMany({ where: { id: input.id, userId: ctx.user.userId } });
      return { success: true };
    }),
});

// ─── Notification Preferences sub-router ────────────────────────────
const notificationPrefsSchema = z.object({
  push: z.object({
    reservations: z.boolean(),
    promotions: z.boolean(),
    reminders: z.boolean(),
    insider: z.boolean(),
    nearby: z.boolean(),
    // Optional so a client built before party alerts existed can still save
    // preferences without silently dropping the member's party choice.
    party: z.boolean().optional(),
  }),
  email: z.object({
    reservations: z.boolean(),
    promotions: z.boolean(),
    newsletter: z.boolean(),
    receipts: z.boolean(),
  }),
  sms: z.object({
    reservations: z.boolean(),
    reminders: z.boolean(),
    emergencies: z.boolean(),
  }),
});

const DEFAULT_NOTIFICATION_PREFS = {
  push: { reservations: true, promotions: true, reminders: true, insider: true, nearby: false, party: true },
  email: { reservations: true, promotions: false, newsletter: true, receipts: true },
  sms: { reservations: true, reminders: true, emergencies: true },
};

/**
 * Rebuilds one preference channel from the defaults, so only known keys with
 * boolean values survive. Stored JSON is untrusted: legacy rows, arrays and
 * hand-edited values must not be copied back into the saved shape, and a
 * non-boolean would read as "unset" at delivery time and silently restore the
 * default the member had switched off.
 */
function mergeChannel<T extends Record<string, boolean>>(
  defaults: T,
  stored: unknown,
  channel: string,
  input: Partial<T>,
): T {
  const merged = { ...defaults };
  const container = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)[channel]
    : undefined;
  const storedChannel = container && typeof container === 'object' && !Array.isArray(container)
    ? (container as Record<string, unknown>)
    : {};

  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const previous = storedChannel[key as string];
    if (typeof previous === 'boolean') merged[key] = previous as T[keyof T];
    const next = input[key];
    if (typeof next === 'boolean') merged[key] = next as T[keyof T];
  }
  return merged;
}

/** The stored record rebuilt into the shape every caller is entitled to assume. */
function sanitizeNotificationPrefs(stored: unknown): typeof DEFAULT_NOTIFICATION_PREFS {
  return {
    push: mergeChannel(DEFAULT_NOTIFICATION_PREFS.push, stored, 'push', {}),
    email: mergeChannel(DEFAULT_NOTIFICATION_PREFS.email, stored, 'email', {}),
    sms: mergeChannel(DEFAULT_NOTIFICATION_PREFS.sms, stored, 'sms', {}),
  };
}

const notificationsRouter = router({
  /** Get user's notification preferences */
  getPrefs: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUnique({
      where: { id: ctx.user.userId },
      select: { notificationPrefs: true },
    });
    // Rebuilt rather than returned raw: a malformed row must not reach the
    // client as a settings screen it cannot render or honestly represent.
    return sanitizeNotificationPrefs(user?.notificationPrefs);
  }),

  /** Update user's notification preferences */
  updatePrefs: protectedProcedure
    .input(notificationPrefsSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await db.user.findUnique({
        where: { id: ctx.user.userId },
        select: { notificationPrefs: true },
      });
      // A client that predates a category omits it. Merging over what is
      // already stored keeps an existing opt-out switched off instead of
      // silently turning it back on when an older build saves.
      const stored = existing?.notificationPrefs;
      const merged = {
        push: mergeChannel(DEFAULT_NOTIFICATION_PREFS.push, stored, 'push', input.push),
        email: mergeChannel(DEFAULT_NOTIFICATION_PREFS.email, stored, 'email', input.email),
        sms: mergeChannel(DEFAULT_NOTIFICATION_PREFS.sms, stored, 'sms', input.sms),
      };

      await db.user.update({
        where: { id: ctx.user.userId },
        data: { notificationPrefs: merged as any },
      });
      return { success: true };
    }),
});

/**
 * Account lifecycle — App Store guideline 5.1.1(v) requires in-app account
 * deletion. Deletion is soft for a fixed grace period so a mistaken or coerced
 * request stays recoverable, then the row is purged irreversibly.
 */
const accountRouter = router({
  /** Current deletion state, so the client can show the countdown. */
  deletionStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUnique({
      where: { id: ctx.user.userId },
      select: { deletedAt: true, purgeAfter: true },
    });
    return {
      pendingDeletion: Boolean(user?.deletedAt),
      purgeAfter: user?.purgeAfter?.toISOString() ?? null,
      graceDays: DELETION_GRACE_DAYS,
    };
  }),

  /** Request deletion. Idempotent: re-requesting does not extend the window. */
  requestDeletion: protectedProcedure
    .input(z.object({ reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUnique({
        where: { id: ctx.user.userId },
        select: { deletedAt: true, purgeAfter: true },
      });
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
      }
      if (user.deletedAt && isWithinGracePeriod(user.purgeAfter)) {
        return { purgeAfter: user.purgeAfter!.toISOString(), graceDays: DELETION_GRACE_DAYS };
      }

      const requestedAt = new Date();
      const purgeAfter = purgeDateFrom(requestedAt);
      await db.user.update({
        where: { id: ctx.user.userId },
        data: { deletedAt: requestedAt, purgeAfter, deletionReason: input.reason ?? null },
      });
      // Identity hashes go immediately: a member who asked to leave must stop
      // surfacing in other people's contact discovery at once, even though the
      // row itself survives for the grace period.
      await db.userIdentityHash.deleteMany({ where: { userId: ctx.user.userId } });
      await revokeSessions(ctx.user.userId);

      return { purgeAfter: purgeAfter.toISOString(), graceDays: DELETION_GRACE_DAYS };
    }),

  /** Cancel a pending deletion while still inside the grace period. */
  cancelDeletion: protectedProcedure.mutation(async ({ ctx }) => {
    const user = await db.user.findUnique({
      where: { id: ctx.user.userId },
      select: { deletedAt: true, purgeAfter: true },
    });
    if (!user?.deletedAt) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No deletion is pending' });
    }
    if (!isWithinGracePeriod(user.purgeAfter)) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The grace period for this account has elapsed' });
    }

    await db.user.update({
      where: { id: ctx.user.userId },
      data: { deletedAt: null, purgeAfter: null, deletionReason: null },
    });
    await restoreSessions(ctx.user.userId);
    return { restored: true };
  }),
});

// ─── Compose user router ────────────────────────────────────────────
const presenceRouter = router({
  /** Home header count: everyone active in the app, so a new arrival can see
   *  the room is occupied before they know anyone in it. The window is
   *  returned so the client states it rather than implies it. */
  summary: protectedProcedure
    .input(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional())
    .query(async ({ ctx, input }) => {
      // The cell is derived here rather than accepted: a client that names its
      // own room can inflate one. Coordinates pick the cell and are not stored.
      const cell = input ? cellFor(input.lat, input.lng) : null;
      await recordActive(ctx.user.userId, cell);
      const [area, members] = await Promise.all([activeCount(cell), memberCount()]);
      return { ...resolveSummary(area, members, cell), windowMs: ACTIVE_WINDOW_MS };
    }),
});

export const userRouter = router({
  presence: presenceRouter,
  points: pointsRouter,
  achievements: achievementsRouter,
  checkins: checkinsRouter,
  savedSpots: savedSpotsRouter,
  preferences: preferencesRouter,
  profile: profileRouter,
  vehicles: vehiclesRouter,
  notifications: notificationsRouter,
  account: accountRouter,
});

