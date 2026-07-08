import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { createPublicCaller, createAuthenticatedCaller } from './helpers';
import { db } from '../lib/db';
import { config } from '../config';

const stripeCheckoutSessionsCreate = vi.hoisted(() => vi.fn());
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(function StripeMock() {
    return { checkout: { sessions: { create: stripeCheckoutSessionsCreate } } };
  }),
}));

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
  stripeCheckoutSessionsCreate.mockReset();
  config.stripeSecretKey = '';
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
// Native bootstrap
// ──────────────────────────────────────────────────────────
describe('native.bootstrap', () => {
  it('returns a guest-safe shell payload with fallbacks when live venues are unavailable', async () => {
    (db.venue.findMany as any).mockResolvedValueOnce([]);

    const caller = createPublicCaller();
    const result = await caller.native.bootstrap();

    expect(result.version).toBe(2);
    expect(result.content.source).toBe('fallback');
    expect(result.content.venues.length).toBeGreaterThan(0);
    expect(result.content.discoverCards.some((card) => card.id === 'service-valet-ride')).toBe(true);
    expect(result.account.mode).toBe('guest');
    expect(result.account.profileReadiness.completed).toBe(0);
    expect(result.featureFlags.nativeBootstrap).toBe(true);
  });

  it('hydrates live venue cards when venues are available', async () => {
    (db.venue.findMany as any).mockResolvedValueOnce([
      {
        id: 'venue-1', name: 'Test Garage', slug: 'test-garage', address: '1 Test Way', lat: 33.78, lng: -84.38,
        category: 'parking', imageUrl: null, entryType: 'paid', entryPrice: '$9/hr', ticketUrl: null,
        crowdLevels: [{ level: 1, label: 'Easy', waitMins: 0, recordedAt: new Date('2026-01-01T00:00:00Z') }],
        parking: [{ name: 'Main Deck', type: 'garage', available: 12, totalSpots: 80, pricePerHr: 9 }],
      },
    ]);

    const caller = createPublicCaller();
    const result = await caller.native.bootstrap({ limit: 6 });

    expect(result.content.source).toBe('mixed');
    expect(result.freshness.sections).toEqual(expect.objectContaining({ venues: 'live', events: 'fallback', discoverCards: 'live' }));
    expect(result.content.venues[0].parking.totalAvailable).toBe(12);
    expect(result.content.discoverCards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'venue-venue-1', type: 'parking', metadataLine: '$9/hr • 12 spots' }),
    ]));
  });

  it('includes authenticated profile readiness and saved places when a token is attached', async () => {
    (db.user.findUnique as any).mockResolvedValueOnce({
      id: 'user-1', email: 'rider@test.com', name: 'Rider Test', phone: '+15551234567', address: null,
      birthday: null, vehicles: [{ make: 'Tesla', model: 'Model 3' }], isPremium: true, stripeCustomerId: 'cus_test', createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    (db.savedSpot.findMany as any).mockResolvedValueOnce([
      { id: 'saved-1', venueId: 'venue-1', savedAt: new Date('2026-01-02T00:00:00Z'), venue: { name: 'Colony Square', address: '1197 Peachtree', category: 'dining', imageUrl: null } },
    ]);

    const caller = createAuthenticatedCaller('user-1', 'rider@test.com');
    const result = await caller.native.bootstrap();

    expect(result.account.mode).toBe('authenticated');
    expect(result.account.profileReadiness.completed).toBe(2);
    expect(result.account.paymentReadiness.ready).toBe(false);
    expect(result.account.paymentReadiness.hasStripeCustomer).toBe(true);
    expect(result.account.paymentReadiness.savedMethodCount).toBe(0);
    expect(result.account.activeBookings.source).toBe('server');
    expect(result.account.savedPlaces[0]).toEqual(expect.objectContaining({ title: 'Colony Square' }));
  });
});

describe('native.walletLedger', () => {
  it('returns server-authoritative wallet ledger entries for the signed-in user', async () => {
    (db.walletLedgerEntry.findMany as any).mockResolvedValueOnce([
      {
        id: 'ledger-1', productType: 'airport_transfer', title: 'Airport Transfer', subtitle: 'ATL → Midtown',
        venueName: 'Airport Transfer', providerName: 'Elife Transfer', windowLabel: 'Today · 8:00 PM',
        paymentState: 'authorization_pending', providerState: 'pending_authorization', reservationReference: 'quote-123',
        amountCents: 9600, currency: 'usd', source: 'server_checkout', receiptUrl: null,
        actions: [{ id: 'open_access', title: 'Open My Access' }], metadata: { quoteId: 'quote-123' },
        createdAt: new Date('2026-01-03T00:00:00Z'), updatedAt: new Date('2026-01-03T00:00:00Z'),
      },
    ]);

    const caller = createAuthenticatedCaller('user-ledger-1', 'wallet@test.com');
    const result = await caller.native.walletLedger({ limit: 3 });

    expect(db.walletLedgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-ledger-1' }, take: 3 }));
    expect(result.source).toBe('server');
    expect(result.count).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({ id: 'ledger-1', productType: 'airport_transfer', paymentState: 'authorization_pending', providerState: 'pending_authorization', reservationReference: 'quote-123' }));
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
// Payments
// ──────────────────────────────────────────────────────────
describe('payments', () => {
  it('payments.checkout keeps parking defaults for legacy parking callers', async () => {
    config.stripeSecretKey = 'configured_for_parking_checkout_test';
    stripeCheckoutSessionsCreate.mockResolvedValueOnce({ id: 'cs_parking_123', payment_intent: 'pi_parking_123', url: 'https://checkout.stripe.test/pay/cs_parking_123' });

    const caller = createAuthenticatedCaller('user-parking-1', 'driver@test.com');
    const result = await caller.payments.checkout({
      spotId: 'spot-123',
      spotName: 'Colony Square Garage',
      address: '1197 Peachtree St NE',
      duration: 2.5,
      totalCost: 18.75,
    });

    expect(result.url).toBe('https://checkout.stripe.test/pay/cs_parking_123');
    expect(result.ledgerEntryId).toBe('wle-1');
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      line_items: [expect.objectContaining({
        price_data: expect.objectContaining({
          unit_amount: 1875,
          product_data: expect.objectContaining({ name: 'Parking — Colony Square Garage' }),
        }),
      })],
      metadata: expect.objectContaining({ flow: 'parking.checkout', productType: 'parking', spotId: 'spot-123', amountCents: '1875' }),
      success_url: expect.stringContaining('/parking/success?session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: expect.stringContaining('/parking/cancelled'),
    }));
    expect(db.walletLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-parking-1', productType: 'parking', paymentState: 'checkout_pending', providerState: 'payment_pending', amountCents: 1875 }),
    }));
  });

  it('payments.checkout supports native authorization products without parking labels or automatic capture', async () => {
    config.stripeSecretKey = 'configured_for_native_authorization_checkout_test';
    stripeCheckoutSessionsCreate.mockResolvedValueOnce({ id: 'cs_airport_123', payment_intent: 'pi_airport_123', url: 'https://checkout.stripe.test/pay/cs_airport_123' });

    const caller = createAuthenticatedCaller('user-airport-1', 'traveler@test.com');
    const result = await caller.payments.checkout({
      spotId: 'native-private-airport-transfer',
      spotName: 'Airport Transfer',
      address: 'ATL → Midtown',
      duration: 1,
      totalCost: 96,
      productType: 'airport_transfer',
      successPath: '/booking/success?from=airport',
      cancelPath: '/booking/cancelled',
      source: 'native-private-airport-transfer',
      metadata: { captureMode: 'manual_after_authorization', quoteId: 'quote-123' },
    });

    expect(result.url).toBe('https://checkout.stripe.test/pay/cs_airport_123');
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      line_items: [expect.objectContaining({
        price_data: expect.objectContaining({
          unit_amount: 9600,
          product_data: expect.objectContaining({ name: 'Airport Transfer — Airport Transfer', description: 'Transfer authorization for ATL → Midtown' }),
        }),
      })],
      metadata: expect.objectContaining({ flow: 'native.airport_transfer.checkout', source: 'native-private-airport-transfer', productType: 'airport_transfer', captureMode: 'manual_after_authorization', quoteId: 'quote-123' }),
      payment_intent_data: expect.objectContaining({ capture_method: 'manual', metadata: expect.objectContaining({ productType: 'airport_transfer', captureMode: 'manual_after_authorization' }) }),
      success_url: expect.stringContaining('/booking/success?from=airport&session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: expect.stringContaining('/booking/cancelled'),
    }));
    expect(db.walletLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-airport-1', productType: 'airport_transfer', title: 'Airport Transfer', providerName: 'Elife Transfer',
        paymentState: 'authorization_pending', providerState: 'pending_authorization', reservationReference: 'quote-123', amountCents: 9600,
      }),
    }));
  });

  it('payments.checkout manually captures boutique stays and preserves top-level native source', async () => {
    config.stripeSecretKey = 'configured_for_native_stay_checkout_test';
    stripeCheckoutSessionsCreate.mockResolvedValueOnce({ id: 'cs_stay_123', payment_intent: 'pi_stay_123', url: 'https://checkout.stripe.test/pay/cs_stay_123' });

    const caller = createAuthenticatedCaller('user-stay-1', 'guest@test.com');
    const result = await caller.payments.checkout({
      spotId: 'native-boutique-stay-venue-1',
      spotName: 'Juniper Boutique Loft',
      address: 'Midtown Atlanta',
      duration: 2,
      totalCost: 420,
      productType: 'boutique_stay',
      successPath: '/booking/success',
      cancelPath: '/booking/cancelled',
      source: 'native-boutique-stay',
      metadata: { captureMode: 'manual_after_host_approval', nightsLabel: '2 nights' },
    });

    expect(result.url).toBe('https://checkout.stripe.test/pay/cs_stay_123');
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [expect.objectContaining({
        price_data: expect.objectContaining({
          unit_amount: 42000,
          product_data: expect.objectContaining({ name: 'Boutique Stay — Juniper Boutique Loft', description: 'Stay authorization for Midtown Atlanta' }),
        }),
      })],
      metadata: expect.objectContaining({ flow: 'native.boutique_stay.checkout', source: 'native-boutique-stay', productType: 'boutique_stay', captureMode: 'manual_after_host_approval', nightsLabel: '2 nights' }),
      payment_intent_data: expect.objectContaining({ capture_method: 'manual', metadata: expect.objectContaining({ source: 'native-boutique-stay', productType: 'boutique_stay' }) }),
    }));
    expect(db.walletLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-stay-1', productType: 'boutique_stay', paymentState: 'authorization_pending', providerState: 'host_review_pending', windowLabel: '2 nights' }),
    }));
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