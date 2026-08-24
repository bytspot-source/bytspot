import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { createPublicCaller, createAuthenticatedCaller } from './helpers';
import { db } from '../lib/db';
import { normalizeIosDeviceToken } from '../services/iosPushDevices';
import { isAllowedBytspotUrl, venueNotificationUrl } from '../services/notificationDelivery';

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────
describe('health', () => {
  it('health.check returns healthy when DB is reachable', async () => {
    const caller = createPublicCaller();
    const result = await caller.health.check();
    expect(result.status).toBe('healthy');
    expect(result.checks.api).toBe('ok');
    expect(result.checks.postgres).toBe('ok');
  });

  it('health.check returns degraded when DB query fails', async () => {
    (db.$queryRaw as any).mockRejectedValueOnce(new Error('pg down'));
    const caller = createPublicCaller();
    const result = await caller.health.check();
    expect(result.status).toBe('degraded');
    expect(result.checks.postgres).toBe('error');
  });

  it('health.stats returns fallback counts', async () => {
    (db.user.count as any).mockRejectedValueOnce(new Error('db err'));
    const caller = createPublicCaller();
    const result = await caller.health.stats();
    // Fallback values from the catch block
    expect(result).toHaveProperty('userCount');
    expect(result).toHaveProperty('venueCount');
  });
});

// ──────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────
describe('auth', () => {
  it('auth.signup creates a user and returns a token', async () => {
    (db.user.findUnique as any).mockResolvedValueOnce(null);
    (db.user.create as any).mockResolvedValueOnce({
      id: 'new-user-id', email: 'alice@test.com', name: 'Alice',
    });

    const caller = createPublicCaller();
    const result = await caller.auth.signup({
      email: 'alice@test.com', password: 'password123', name: 'Alice',
    });

    expect(result.token).toBeTruthy();
    expect(result.user.email).toBe('alice@test.com');
    expect(db.user.create).toHaveBeenCalledOnce();
  });

  it('auth.signup rejects duplicate email', async () => {
    (db.user.findUnique as any).mockResolvedValueOnce({ id: 'existing', email: 'dup@test.com' });

    const caller = createPublicCaller();
    await expect(
      caller.auth.signup({ email: 'dup@test.com', password: 'password123' }),
    ).rejects.toThrow(TRPCError);
  });

  it('auth.login returns token for valid credentials', async () => {
    const bcrypt = await import('bcryptjs');
    const hashed = await bcrypt.hash('password123', 12);
    (db.user.findUnique as any).mockResolvedValueOnce({
      id: 'user-1', email: 'bob@test.com', name: 'Bob', password: hashed,
    });

    const caller = createPublicCaller();
    const result = await caller.auth.login({ email: 'bob@test.com', password: 'password123' });
    expect(result.token).toBeTruthy();
    expect(result.user.id).toBe('user-1');
  });

  it('auth.login rejects wrong password', async () => {
    const bcrypt = await import('bcryptjs');
    const hashed = await bcrypt.hash('correctpassword', 12);
    (db.user.findUnique as any).mockResolvedValueOnce({
      id: 'user-1', email: 'bob@test.com', password: hashed,
    });

    const caller = createPublicCaller();
    await expect(
      caller.auth.login({ email: 'bob@test.com', password: 'wrongpassword' }),
    ).rejects.toThrow(TRPCError);
  });

  it('auth.me requires authentication', async () => {
    const caller = createPublicCaller();
    await expect(caller.auth.me()).rejects.toThrow(TRPCError);
  });

  it('auth.me returns user profile when authenticated', async () => {
    (db.user.findUnique as any).mockResolvedValueOnce({
      id: 'user-1', email: 'bob@test.com', name: 'Bob', ref: null, createdAt: new Date(),
    });
    (db.user.count as any).mockResolvedValueOnce(3);

    const caller = createAuthenticatedCaller('user-1', 'bob@test.com');
    const result = await caller.auth.me();
    expect(result.user.email).toBe('bob@test.com');
    expect(result.referralCount).toBe(3);
  });
});


// ──────────────────────────────────────────────────────────
// Venues
// ──────────────────────────────────────────────────────────
describe('venues', () => {
  it('venues.list returns venue array', async () => {
    (db.venue.findMany as any).mockResolvedValueOnce([
      {
        id: 'v1', name: 'Test Bar', slug: 'test-bar', address: '123 Main St',
        lat: 33.78, lng: -84.38, category: 'bar', imageUrl: null,
        crowdLevels: [{ level: 2, label: 'Active', waitMins: 10, recordedAt: new Date() }],
        parking: [{ name: 'Lot A', type: 'lot', available: 5, totalSpots: 20, pricePerHr: 5 }],
      },
    ]);

    const caller = createPublicCaller();
    const result = await caller.venues.list();
    expect(result.venues).toHaveLength(1);
    expect(result.venues[0].name).toBe('Test Bar');
    expect(result.venues[0].crowd?.label).toBe('Active');
    expect(result.venues[0].parking.totalAvailable).toBe(5);
  });

  it('venues.getBySlug returns 404 for missing venue', async () => {
    (db.venue.findUnique as any).mockResolvedValueOnce(null);
    const caller = createPublicCaller();
    await expect(
      caller.venues.getBySlug({ slug: 'nonexistent' }),
    ).rejects.toThrow(TRPCError);
  });

  it('venues.checkin increments crowd level for a check-in inside the fence', async () => {
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'v1', name: 'Test Bar', slug: 'test-bar', lat: 33.78, lng: -84.38 });
    (db.crowdLevel.findFirst as any).mockResolvedValueOnce({ level: 2 });
    (db.crowdLevel.create as any).mockResolvedValueOnce({});

    const caller = createAuthenticatedCaller();
    const result = await caller.venues.checkin({ venueId: 'v1', lat: 33.7801, lng: -84.3801 });
    expect(result.success).toBe(true);
    expect(result.proof).toBe('nearby');
    expect(result.pointsEarned).toBe(10);
    expect(result.newCrowdLevel).toBe(3);
  });

  it('venues.checkin records but does not reward or move the crowd for an unproven tap', async () => {
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'v1', name: 'Test Bar', slug: 'test-bar', lat: 33.78, lng: -84.38 });
    (db.crowdLevel.findFirst as any).mockResolvedValueOnce({ level: 2 });

    // No coordinate: the server cannot tell the door from the sofa, so the
    // tap is the member's own history and nothing more.
    const caller = createAuthenticatedCaller();
    const result = await caller.venues.checkin({ venueId: 'v1' });
    expect(result.success).toBe(true);
    expect(result.proof).toBe('self_reported');
    expect(result.pointsEarned).toBe(0);
    expect(result.newCrowdLevel).toBe(2);
  });

  it('venues.checkin rejects unauthenticated calls', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.venues.checkin({ venueId: 'v1' }),
    ).rejects.toThrow(TRPCError);
  });

  it('venues.checkin returns NOT_FOUND for invalid venue', async () => {
    (db.venue.findUnique as any).mockResolvedValueOnce(null);
    const caller = createAuthenticatedCaller();
    await expect(
      caller.venues.checkin({ venueId: 'bad-id' }),
    ).rejects.toThrow(TRPCError);
  });
});

// ──────────────────────────────────────────────────────────
// Rides
// ──────────────────────────────────────────────────────────
describe('rides', () => {
  it('rides.get never returns simulated provider estimates', async () => {
    const caller = createPublicCaller();
    const result = await caller.rides.get({ lat: 33.78, lng: -84.38 });
    expect(result.available).toBe(false);
    expect(result.providers).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────
// Admin
// ──────────────────────────────────────────────────────────
describe('admin', () => {
  it('admin.stats rejects an unauthenticated caller', async () => {
    const caller = createPublicCaller();
    await expect(caller.admin.stats()).rejects.toThrow(TRPCError);
  });

  it('admin.stats forbids an authenticated non-admin', async () => {
    const caller = createAuthenticatedCaller('u-1', 'guest@bytspot.com');
    await expect(caller.admin.stats()).rejects.toThrow(TRPCError);
  });

  it('admin.stats returns stats for an admin-group caller', async () => {
    (db.user.count as any).mockResolvedValue(42);
    (db.crowdLevel.count as any).mockResolvedValueOnce(100);
    (db.crowdLevel.groupBy as any).mockResolvedValueOnce([]);
    (db.venue.findMany as any).mockResolvedValueOnce([]);

    const caller = createAuthenticatedCaller('admin-1', 'ops@bytspot.com');
    const result = await caller.admin.stats();
    expect(result.totalUsers).toBe(42);
    expect(result.totalCheckins).toBe(100);
    expect(result).toHaveProperty('generatedAt');
  });

  it('admin.generateInvite forbids an authenticated non-admin', async () => {
    const caller = createAuthenticatedCaller('u-2', 'guest2@bytspot.com');
    await expect(caller.admin.generateInvite({ count: 1 })).rejects.toThrow(TRPCError);
  });
});

// ──────────────────────────────────────────────────────────
// Beta Signup
// ──────────────────────────────────────────────────────────
describe('betaSignup', () => {
  it('betaSignup.signup creates a new lead', async () => {
    (db.betaLead.findUnique as any).mockResolvedValueOnce(null);
    (db.betaLead.create as any).mockResolvedValueOnce({});

    const caller = createPublicCaller();
    const result = await caller.betaSignup.signup({ email: 'new@test.com', name: 'New User' });
    expect(result.ok).toBe(true);
    expect(result.alreadyRegistered).toBe(false);
    expect(db.betaLead.create).toHaveBeenCalledOnce();
  });

  it('betaSignup.signup returns alreadyRegistered for duplicates', async () => {
    (db.betaLead.findUnique as any).mockResolvedValueOnce({ email: 'dup@test.com' });

    const caller = createPublicCaller();
    const result = await caller.betaSignup.signup({ email: 'dup@test.com' });
    expect(result.ok).toBe(true);
    expect(result.alreadyRegistered).toBe(true);
  });

  it('betaSignup.signup rejects invalid email', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.betaSignup.signup({ email: 'not-an-email' }),
    ).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────
// Push
// ──────────────────────────────────────────────────────────
describe('push', () => {
  it('push.vapidPublicKey returns the configured key', async () => {
    const caller = createPublicCaller();
    const result = await caller.push.vapidPublicKey();
    expect(result.key).toBe('test-vapid-public');
  });
});

// ──────────────────────────────────────────────────────────
// Providers (requires auth)
// ──────────────────────────────────────────────────────────
describe('providers', () => {
  it('providers.getStatus rejects unauthenticated calls', async () => {
    const caller = createPublicCaller();
    await expect(caller.providers.getStatus()).rejects.toThrow(TRPCError);
  });

  it('providers.getStatus returns null profiles for new user', async () => {
    (db.hostProfile.findUnique as any).mockResolvedValueOnce(null);
    (db.valetProfile.findUnique as any).mockResolvedValueOnce(null);

    const caller = createAuthenticatedCaller();
    const result = await caller.providers.getStatus();
    expect(result.host).toBeNull();
    expect(result.valet).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────
// Cron
// ──────────────────────────────────────────────────────────
describe('cron', () => {
  it('cron.crowdAlerts rejects wrong secret', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.cron.crowdAlerts({ cronSecret: 'wrong' }),
    ).rejects.toThrow(TRPCError);
  });

  it('cron.crowdAlerts runs with correct secret', async () => {
    const caller = createPublicCaller();
    const result = await caller.cron.crowdAlerts({ cronSecret: 'test-cron-secret' });
    expect(result.ok).toBe(true);
  });
});


// ──────────────────────────────────────────────────────────
// User — Points
// ──────────────────────────────────────────────────────────
describe('user.points', () => {
  it('rejects unauthenticated calls', async () => {
    const caller = createPublicCaller();
    await expect(caller.user.points.get()).rejects.toThrow(TRPCError);
  });

  it('returns zero points for new user', async () => {
    (db.pointTransaction.findMany as any).mockResolvedValueOnce([]);
    const caller = createAuthenticatedCaller();
    const result = await caller.user.points.get();
    expect(result.total).toBe(0);
    expect(result.lifetime).toBe(0);
    expect(result.tier).toBe('bronze');
  });

  it('calculates tier from lifetime points', async () => {
    (db.pointTransaction.findMany as any).mockResolvedValueOnce([
      { id: '1', type: 'earn', amount: 2500, createdAt: new Date() },
    ]);
    const caller = createAuthenticatedCaller();
    const result = await caller.user.points.get();
    expect(result.lifetime).toBe(2500);
    expect(result.tier).toBe('gold');
  });
});

// ──────────────────────────────────────────────────────────
// User — Achievements
// ──────────────────────────────────────────────────────────
describe('user.achievements', () => {
  it('returns all achievements with unlock status', async () => {
    (db.userAchievement.findMany as any).mockResolvedValueOnce([
      { achievementId: 'first_checkin', unlockedAt: new Date() },
    ]);
    const caller = createAuthenticatedCaller();
    const result = await caller.user.achievements.list();
    expect(result.length).toBeGreaterThan(0);
    const first = result.find((a: any) => a.id === 'first_checkin');
    expect(first?.unlocked).toBe(true);
    const explorer = result.find((a: any) => a.id === 'checkin_25');
    expect(explorer?.unlocked).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────
// User — Check-in History
// ──────────────────────────────────────────────────────────
describe('user.checkins', () => {
  it('returns empty list for new user', async () => {
    (db.checkIn.findMany as any).mockResolvedValueOnce([]);
    const caller = createAuthenticatedCaller();
    const result = await caller.user.checkins.list({});
    expect(result.items).toEqual([]);
  });

  it('returns count', async () => {
    (db.checkIn.count as any).mockResolvedValueOnce(5);
    const caller = createAuthenticatedCaller();
    const result = await caller.user.checkins.count();
    expect(result).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────
// User — Saved Spots
// ──────────────────────────────────────────────────────────
describe('user.savedSpots', () => {
  it('saves a venue', async () => {
    (db.savedSpot.upsert as any).mockResolvedValueOnce({ id: 'ss-1', venueId: 'v1' });
    const caller = createAuthenticatedCaller();
    const result = await caller.user.savedSpots.save({ venueId: 'v1' });
    expect(result.id).toBe('ss-1');
  });

  it('removes a saved spot', async () => {
    const caller = createAuthenticatedCaller();
    const result = await caller.user.savedSpots.remove({ venueId: 'v1' });
    expect(result.success).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────
// User — Preferences
// ──────────────────────────────────────────────────────────
describe('user.preferences', () => {
  it('returns defaults for new user', async () => {
    (db.userPreference.findUnique as any).mockResolvedValueOnce(null);
    const caller = createAuthenticatedCaller();
    const result = await caller.user.preferences.get();
    expect(result.interests).toEqual([]);
    expect(result.vibes).toEqual([]);
  });

  it('updates preferences', async () => {
    (db.userPreference.upsert as any).mockResolvedValueOnce({ interests: ['nightlife'], vibes: ['chill'] });
    const caller = createAuthenticatedCaller();
    const result = await caller.user.preferences.update({ interests: ['nightlife'], vibes: ['chill'] });
    expect(result.interests).toContain('nightlife');
  });
});

// ──────────────────────────────────────────────────────────
// Social
// ──────────────────────────────────────────────────────────
describe('social', () => {
  it('rejects following yourself', async () => {
    const caller = createAuthenticatedCaller('user-1');
    await expect(caller.social.follow({ userId: 'user-1' })).rejects.toThrow('Cannot follow yourself');
  });

  it('follows a user', async () => {
    (db.user.findUnique as any).mockResolvedValueOnce({ id: 'user-2', name: 'Bob' });
    (db.follow.upsert as any).mockResolvedValueOnce({ id: 'f-1' });
    const caller = createAuthenticatedCaller('user-1');
    const result = await caller.social.follow({ userId: 'user-2' });
    expect(result.success).toBe(true);
  });

  it('unfollows a user', async () => {
    const caller = createAuthenticatedCaller();
    const result = await caller.social.unfollow({ userId: 'user-2' });
    expect(result.success).toBe(true);
  });

  it('returns empty leaderboard', async () => {
    (db.pointTransaction.groupBy as any).mockResolvedValueOnce([]);
    (db.user.findMany as any).mockResolvedValueOnce([]);
    const caller = createAuthenticatedCaller();
    const result = await caller.social.leaderboard({});
    expect(result).toEqual([]);
  });

  it('returns empty feed when not following anyone', async () => {
    (db.follow.findMany as any).mockResolvedValueOnce([]);
    const caller = createAuthenticatedCaller();
    const result = await caller.social.feed({});
    expect(result.items).toEqual([]);
  });
});


// ──────────────────────────────────────────────────────────
// Native push devices
// ──────────────────────────────────────────────────────────
describe('push.registerIosDevice', () => {
  const uppercaseToken = 'A'.repeat(64);
  const normalizedToken = 'a'.repeat(64);

  it('requires authentication', async () => {
    const caller = createPublicCaller();
    await expect(caller.push.registerIosDevice({
      token: uppercaseToken,
      environment: 'production',
      bundleId: 'com.bytspot.app',
    })).rejects.toThrow(TRPCError);
  });

  it('normalizes and registers a device for the authenticated user only', async () => {
    const caller = createAuthenticatedCaller('owner-id');
    await caller.push.registerIosDevice({
      token: uppercaseToken,
      environment: 'production',
      bundleId: 'com.bytspot.app',
    });

    expect(db.iOSPushDevice.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { token: normalizedToken },
      create: expect.objectContaining({ userId: 'owner-id', token: normalizedToken }),
    }));
  });

  it('rejects malformed tokens, environment mismatch, and cannot unregister another owner device', async () => {
    const caller = createAuthenticatedCaller('owner-id');
    await expect(caller.push.registerIosDevice({
      token: 'not-a-token', environment: 'production', bundleId: 'com.bytspot.app',
    })).rejects.toThrow(TRPCError);
    await expect(caller.push.registerIosDevice({
      token: uppercaseToken, environment: 'sandbox', bundleId: 'com.bytspot.app',
    })).rejects.toThrow(TRPCError);

    await caller.push.unregisterIosDevice({ token: uppercaseToken });
    expect(db.iOSPushDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { token: normalizedToken, userId: 'owner-id', invalidatedAt: null },
    }));
  });
});

describe('push delivery helpers', () => {
  it('strictly normalizes APNs tokens and permits only canonical Bytspot HTTPS URLs', () => {
    expect(normalizeIosDeviceToken(' A'.repeat(64))).toBeNull();
    expect(normalizeIosDeviceToken('A'.repeat(64))).toBe('a'.repeat(64));
    expect(isAllowedBytspotUrl('https://bytspot.app/venue/a')).toBe(true);
    expect(isAllowedBytspotUrl('https://beta.bytspot.com/venue/a')).toBe(false);
    expect(isAllowedBytspotUrl('http://bytspot.app/venue/a')).toBe(false);
    expect(venueNotificationUrl('a/b')).toBe('https://bytspot.app/venue/a%2Fb');
  });
});

// ──────────────────────────────────────────────────────────
// Rate Limiting
// ──────────────────────────────────────────────────────────
describe('rate limiting', () => {
  it('allows requests under the limit', async () => {
    const caller = createPublicCaller();
    // rides.get has a rate limit — should work for a few calls
    const result = await caller.rides.get({ lat: 33.78, lng: -84.38 });
    expect(result.providers).toHaveLength(2);
  });

  it('concierge rejects unauthenticated calls before rate limit applies', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.concierge.ask({ message: 'test' }),
    ).rejects.toThrow(TRPCError);
  });
});

// ──────────────────────────────────────────────────────────
// Input validation
// ──────────────────────────────────────────────────────────
describe('input validation', () => {
  it('auth.signup rejects empty email', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.auth.signup({ email: '', password: 'password123' }),
    ).rejects.toThrow();
  });

  it('auth.signup rejects short password', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.auth.signup({ email: 'test@test.com', password: '12' }),
    ).rejects.toThrow();
  });

  it('venues.checkin rejects empty venueId', async () => {
    const caller = createAuthenticatedCaller();
    await expect(
      caller.venues.checkin({ venueId: '' }),
    ).rejects.toThrow();
  });

  it('rides.get rejects non-numeric coordinates', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.rides.get({ lat: 'abc' as any, lng: -84.38 }),
    ).rejects.toThrow();
  });

  it('betaSignup rejects malformed email', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.betaSignup.signup({ email: 'not-valid' }),
    ).rejects.toThrow();
  });
});