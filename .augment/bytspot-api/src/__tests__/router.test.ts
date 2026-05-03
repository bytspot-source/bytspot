import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { Entity } from '@prisma/client';
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
    (db.$queryRawUnsafe as any).mockResolvedValueOnce([
      { column_name: 'entry_type' },
      { column_name: 'entry_price' },
      { column_name: 'ticket_url' },
    ]);
    (db.venue.findMany as any).mockResolvedValueOnce([
      {
        id: 'v1', name: 'Test Bar', slug: 'test-bar', address: '123 Main St',
        lat: 33.78, lng: -84.38, category: 'bar', imageUrl: null,
        entryType: 'paid', entryPrice: '$22', ticketUrl: 'https://tickets.test/bar',
        crowdLevels: [{ level: 2, label: 'Active', waitMins: 10, recordedAt: new Date() }],
        parking: [{ name: 'Lot A', type: 'lot', available: 5, totalSpots: 20, pricePerHr: 5 }],
      },
    ]);
    (db.hardwarePatch.findMany as any).mockResolvedValueOnce([
      {
        id: 'patch-v1',
        bindingId: 'v1',
        tagType: 'NTAG424_DNA',
        label: 'Front Door',
        readCounter: 9,
        confirmedAt: new Date('2026-04-23T18:00:00.000Z'),
        updatedAt: new Date('2026-04-23T18:05:00.000Z'),
      },
    ]);

    const caller = createPublicCaller();
    const result = await caller.venues.list();
    expect(result.venues).toHaveLength(1);
    expect(result.venues[0].name).toBe('Test Bar');
    expect(result.venues[0].crowd?.label).toBe('Active');
    expect(result.venues[0].parking.totalAvailable).toBe(5);
    expect(result.venues[0].entryType).toBe('paid');
    expect(result.venues[0].entryPrice).toBe('$22');
    expect(result.venues[0].ticketUrl).toBe('https://tickets.test/bar');
    expect(result.venues[0].hardwarePatch).toEqual(expect.objectContaining({ id: 'patch-v1', verifiedVenue: true }));
  });

  it('venues.list falls back to legacy-safe fields when ticketing columns are missing', async () => {
    (db.$queryRawUnsafe as any).mockResolvedValueOnce([]);
    (db.venue.findMany as any).mockResolvedValueOnce([
      {
        id: 'v1', name: 'Legacy Bar', slug: 'legacy-bar', address: '123 Main St',
        lat: 33.78, lng: -84.38, category: 'bar', imageUrl: null,
        crowdLevels: [{ level: 1, label: 'Chill', waitMins: 0, recordedAt: new Date() }],
        parking: [{ name: 'Lot A', type: 'lot', available: 5, totalSpots: 20, pricePerHr: 5 }],
      },
    ]);

    const caller = createPublicCaller();
    const result = await caller.venues.list({ entryType: 'free' });

    expect(result.venues).toHaveLength(1);
    expect(result.venues[0].entryType).toBe('free');
    expect(result.venues[0].entryPrice).toBeNull();
    expect(result.venues[0].ticketUrl).toBeNull();

    const findManyArgs = (db.venue.findMany as any).mock.calls[0][0];
    expect(findManyArgs.where).toBeUndefined();
  });

  it('venues.getBySlug returns ticketing fields for paid venues', async () => {
    (db.$queryRawUnsafe as any).mockResolvedValueOnce([
      { column_name: 'entry_type' },
      { column_name: 'entry_price' },
      { column_name: 'ticket_url' },
    ]);
    (db.venue.findUnique as any).mockResolvedValueOnce({
      id: 'v1', name: 'Test Bar', slug: 'test-bar', address: '123 Main St',
      lat: 33.78, lng: -84.38, category: 'bar', imageUrl: null,
      entryType: 'paid', entryPrice: '$22', ticketUrl: 'https://tickets.test/bar',
      crowdLevels: [{ level: 2, label: 'Active', waitMins: 10, recordedAt: new Date() }],
      parking: [{ name: 'Lot A', type: 'lot', available: 5, totalSpots: 20, pricePerHr: 5 }],
    });

    const caller = createPublicCaller();
    const result = await caller.venues.getBySlug({ slug: 'test-bar' });
    expect(result.entryType).toBe('paid');
    expect(result.entryPrice).toBe('$22');
    expect(result.ticketUrl).toBe('https://tickets.test/bar');
    expect(result.crowd.current?.label).toBe('Active');
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
// Subscription Premium Tiers
// ──────────────────────────────────────────────────────────
describe('subscription', () => {
  it('subscription.status returns vendor and valet premium flags', async () => {
    (db.user.findUnique as any).mockResolvedValueOnce({
      isPremium: false,
      isVendorPremium: true,
      isValetPremium: false,
    });

    const caller = createAuthenticatedCaller();
    const result = await caller.subscription.status();

    expect(result.isPremium).toBe(false);
    expect(result.isVendorPremium).toBe(true);
    expect(result.isValetPremium).toBe(false);
    expect(result.activePlans).toEqual(['vendor-premium']);
  });

  it('subscription.status returns loyalty points and Insider-to-Vendor upgrade discounts', async () => {
    (db.user.findUnique as any).mockResolvedValueOnce({
      isPremium: true,
      isVendorPremium: false,
      isValetPremium: false,
    });
    (db.pointTransaction.findMany as any).mockResolvedValueOnce([
      { type: 'earn', amount: 2500 },
      { type: 'spend', amount: 300 },
      { type: 'SUBSCRIPTION_CREDIT', amount: 200 },
    ]);

    const caller = createAuthenticatedCaller('user-1');
    const result = await caller.subscription.status();

    expect(result.availablePoints).toBe(2000);
    expect(result.eligibleDiscounts.insiderToVendorPremium).toBe(999);
    expect(result.subscriptionOffers['vendor-premium']).toEqual(expect.objectContaining({
      baseUnitAmountCents: 4900,
      upgradeDiscountCents: 999,
      maxPointsDiscountCents: 2000,
    }));
  });

  it('subscription.webhook activates Vendor Premium from checkout metadata', async () => {
    const caller = createPublicCaller();
    await caller.subscription.webhook({
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', metadata: { userId: 'user-1', plan: 'vendor-premium' } } },
    });

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isVendorPremium: true },
    });
  });

  it('subscription.webhook records subscription point credits with the Stripe session id', async () => {
    const caller = createPublicCaller();
    await caller.subscription.webhook({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_points',
          mode: 'subscription',
          metadata: {
            userId: 'user-1',
            plan: 'insider-premium',
            pointsToRedeem: '500',
            pointsDiscountCents: '500',
          },
        },
      },
    });

    expect(db.pointTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'SUBSCRIPTION_CREDIT',
        amount: 500,
        category: 'subscription',
        entity: Entity.BYTSPOT_INC,
        stripeSessionId: 'cs_test_points',
      }),
    });
  });

  it('subscription.webhook marks marketplace booking checkout paid and ledgers point redemption by entity', async () => {
    const caller = createPublicCaller();
    await caller.subscription.webhook({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_booking_points',
          mode: 'payment',
          payment_intent: 'pi_booking_123',
          metadata: {
            flow: 'booking.checkout',
            bookingId: 'booking-1',
            userId: 'user-1',
            entity: Entity.VENDOR_SERVICES,
            pointsToRedeem: '1000',
            pointsDiscountCents: '1000',
          },
        },
      },
    });

    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data: expect.objectContaining({
        status: 'paid',
        stripeSessionId: 'cs_booking_points',
        stripePaymentIntentId: 'pi_booking_123',
      }),
    });
    expect(db.pointTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'MARKETPLACE_CREDIT',
        amount: 1000,
        category: 'marketplace',
        entity: Entity.VENDOR_SERVICES,
        stripeSessionId: 'cs_booking_points',
        stripePaymentIntentId: 'pi_booking_123',
      }),
    });
  });

  it('subscription.webhook marks refunded bookings and restores marketplace points with refund audit id', async () => {
    (db.booking.findUnique as any).mockResolvedValueOnce({
      id: 'booking-1',
      userId: 'user-1',
      entity: Entity.VENDOR_SERVICES,
      status: 'paid',
      stripeSessionId: 'cs_booking_points',
      stripePaymentIntentId: 'pi_booking_123',
      metadata: { pointsToRedeem: '1000', pointsDiscountCents: '1000' },
    });

    const caller = createPublicCaller();
    const result = await caller.subscription.webhook({
      type: 'refund.updated',
      data: {
        object: {
          id: 're_123',
          object: 'refund',
          payment_intent: 'pi_booking_123',
          amount: 14000,
          status: 'succeeded',
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({ bookingId: 'booking-1', status: 'refunded' }));
    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data: expect.objectContaining({ status: 'refunded' }),
    });
    expect(db.pointTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'MARKETPLACE_CREDIT_REVERSAL',
        amount: 1000,
        category: 'marketplace',
        entity: Entity.VENDOR_SERVICES,
        stripeRefundId: 're_123',
      }),
    });
  });

  it('subscription.webhook records open and lost marketplace disputes', async () => {
    (db.booking.findUnique as any)
      .mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        entity: Entity.VENDOR_SERVICES,
        status: 'paid',
        stripeSessionId: 'cs_booking_points',
        stripePaymentIntentId: 'pi_booking_123',
        metadata: { pointsToRedeem: '500', pointsDiscountCents: '500' },
      })
      .mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        entity: Entity.VENDOR_SERVICES,
        status: 'disputed',
        stripeSessionId: 'cs_booking_points',
        stripePaymentIntentId: 'pi_booking_123',
        metadata: { pointsToRedeem: '500', pointsDiscountCents: '500' },
      });

    const caller = createPublicCaller();
    await caller.subscription.webhook({
      type: 'charge.dispute.created',
      data: { object: { id: 'du_123', payment_intent: 'pi_booking_123', status: 'needs_response', amount: 14000 } },
    });
    const result = await caller.subscription.webhook({
      type: 'charge.dispute.closed',
      data: { object: { id: 'du_123', payment_intent: 'pi_booking_123', status: 'lost', amount: 14000 } },
    });

    expect(db.booking.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'booking-1' },
      data: expect.objectContaining({ status: 'disputed' }),
    }));
    expect(db.booking.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'booking-1' },
      data: expect.objectContaining({ status: 'refunded' }),
    }));
    expect(db.pointTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'MARKETPLACE_CREDIT_REVERSAL',
        amount: 500,
        stripeDisputeId: 'du_123',
      }),
    });
    expect(result).toEqual(expect.objectContaining({ bookingId: 'booking-1', status: 'refunded' }));
  });

  it('subscription.webhook deactivates Valet Premium on subscription deletion', async () => {
    const caller = createPublicCaller();
    await caller.subscription.webhook({
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_123', metadata: { plan: 'valet-premium' } } },
    });

    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_123' },
      data: { isValetPremium: false },
    });
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

  it('restores marketplace credit reversals to balance without inflating lifetime points', async () => {
    (db.pointTransaction.findMany as any).mockResolvedValueOnce([
      { id: '1', type: 'earn', amount: 2500, createdAt: new Date() },
      { id: '2', type: 'MARKETPLACE_CREDIT', amount: 1000, createdAt: new Date() },
      { id: '3', type: 'MARKETPLACE_CREDIT_REVERSAL', amount: 1000, createdAt: new Date() },
    ]);

    const caller = createAuthenticatedCaller();
    const result = await caller.user.points.get();

    expect(result.total).toBe(2500);
    expect(result.lifetime).toBe(2500);
    expect(result.spent).toBe(1000);
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
    const caller = createPublicCaller();
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