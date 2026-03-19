import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { createPublicCaller, createAuthenticatedCaller } from './helpers';
import { db } from '../lib/db';

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

  it('venues.checkin increments crowd level (authenticated)', async () => {
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'v1', name: 'Test Bar', slug: 'test-bar' });
    (db.crowdLevel.findFirst as any).mockResolvedValueOnce({ level: 2 });
    (db.crowdLevel.create as any).mockResolvedValueOnce({});

    const caller = createAuthenticatedCaller();
    const result = await caller.venues.checkin({ venueId: 'v1' });
    expect(result.success).toBe(true);
    expect(result.newCrowdLevel).toBe(3);
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
  it('rides.get returns providers with ETAs and prices', async () => {
    const caller = createPublicCaller();
    const result = await caller.rides.get({ lat: 33.78, lng: -84.38 });
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0].name).toBe('Uber');
    expect(result.providers[1].name).toBe('Lyft');
    expect(result.location.lat).toBe(33.78);
  });
});

// ──────────────────────────────────────────────────────────
// Admin
// ──────────────────────────────────────────────────────────
describe('admin', () => {
  it('admin.stats rejects wrong password', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.admin.stats({ adminPassword: 'wrong' }),
    ).rejects.toThrow(TRPCError);
  });

  it('admin.stats returns stats with correct password', async () => {
    (db.user.count as any).mockResolvedValue(42);
    (db.crowdLevel.count as any).mockResolvedValueOnce(100);
    (db.crowdLevel.groupBy as any).mockResolvedValueOnce([]);
    (db.venue.findMany as any).mockResolvedValueOnce([]);

    const caller = createPublicCaller();
    const result = await caller.admin.stats({ adminPassword: 'test-admin-pass' });
    expect(result.totalUsers).toBe(42);
    expect(result.totalCheckins).toBe(100);
    expect(result).toHaveProperty('generatedAt');
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
