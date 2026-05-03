import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Entity } from '@prisma/client';
import { db } from '../lib/db';
import { config } from '../config';
import { createAuthenticatedCaller } from '../__tests__/helpers';
import { __resetICTKeysForTests, verifyICT } from '../services/ictSigner';

const stripeCheckoutSessionsCreate = vi.hoisted(() => vi.fn());
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(function StripeMock() {
    return {
    checkout: { sessions: { create: stripeCheckoutSessionsCreate } },
    };
  }),
}));

const originalNodeEnv = process.env.NODE_ENV;

const boundPatch = {
  id: 'patch-1',
  uid: '04A1B2C3D4E5F6',
  tagType: 'NTAG424_DNA',
  label: 'VIP Booth',
  readCounter: 4,
  status: 'bound',
  bindingType: 'service',
  bindingId: 'svc-1',
  confirmedAt: new Date('2026-04-23T18:00:00.000Z'),
  updatedAt: new Date('2026-04-23T18:05:00.000Z'),
};

describe('booking router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeCheckoutSessionsCreate.mockReset();
    process.env.NODE_ENV = 'development';
    config.stripeSecretKey = '';
    __resetICTKeysForTests();
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    __resetICTKeysForTests();
  });

  it('creates a confirmed booking, stores the ICT jti, and returns patch-linked access token', async () => {
    (db.vendorService.findUnique as any).mockResolvedValueOnce({
      id: 'svc-1',
      title: 'VIP Arrival',
      description: 'Door-to-table escort',
      priceCents: 15000,
      currency: 'USD',
      durationMins: 90,
      status: 'active',
      vendor: { id: 'vendor-1', displayName: 'Midtown Hosts', commissionBps: 800 },
      patch: boundPatch,
    });
    (db.booking.create as any).mockImplementationOnce(({ data }: any) => ({
      id: 'booking-1',
      userId: 'user-1',
      status: data.status,
      priceCents: data.priceCents,
      platformFeeCents: data.platformFeeCents,
      currency: data.currency,
      stripePaymentIntentId: null,
      ictJti: data.ictJti,
      scheduledFor: data.scheduledFor,
      completedAt: null,
      metadata: data.metadata,
      createdAt: new Date('2026-04-23T19:00:00.000Z'),
      updatedAt: new Date('2026-04-23T19:00:00.000Z'),
      service: {
        id: 'svc-1',
        title: 'VIP Arrival',
        description: 'Door-to-table escort',
        durationMins: 90,
        status: 'active',
        patch: boundPatch,
      },
      vendor: { id: 'vendor-1', displayName: 'Midtown Hosts' },
    }));

    const caller = createAuthenticatedCaller('user-1', 'guest@test.com');
    const result = await caller.booking.create({
      serviceId: 'svc-1',
      scheduledFor: '2026-04-23T20:00:00.000Z',
      metadata: { partySize: 4 },
      ttlSec: 600,
      device: { platform: 'ios', fingerprint: 'fp-1' },
    });

    expect(db.booking.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        serviceId: 'svc-1',
        vendorId: 'vendor-1',
        userId: 'user-1',
        status: 'confirmed',
        platformFeeCents: 1200,
      }),
      select: expect.any(Object),
    });

    const claims = verifyICT(result.access.token);
    expect(result.booking.service.patch).toEqual(expect.objectContaining({ id: 'patch-1', uid: '04A1B2C3D4E5F6' }));
    expect(result.access.ictJti).toBe(result.booking.ictJti);
    expect(claims.action).toBe('vendor.booking');
    expect(claims.resource).toEqual({ type: 'booking', id: 'booking-1' });
    expect(claims.patchId).toBe('patch-1');
    expect(db.complianceLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        procedure: 'booking.create',
        outcome: 'allow',
      }),
    });
  });

  it('rejects attempts to book inactive vendor services', async () => {
    (db.vendorService.findUnique as any).mockResolvedValueOnce({
      id: 'svc-1',
      title: 'VIP Arrival',
      description: null,
      priceCents: 15000,
      currency: 'USD',
      durationMins: 90,
      status: 'draft',
      vendor: { id: 'vendor-1', displayName: 'Midtown Hosts', commissionBps: 800 },
      patch: null,
    });

    const caller = createAuthenticatedCaller('user-1', 'guest@test.com');
    await expect(caller.booking.create({ serviceId: 'svc-1' })).rejects.toThrow('Only active vendor services can be booked');
  });

  it('creates a Stripe Connect checkout session with application fee and entity metadata', async () => {
    config.stripeSecretKey = 'sk_test_transaction_metadata';
    (db.vendorService.findUnique as any).mockResolvedValueOnce({
      id: 'svc-1',
      title: 'VIP Arrival',
      description: 'Door-to-table escort',
      priceCents: 15000,
      currency: 'USD',
      durationMins: 90,
      status: 'active',
      vendor: {
        id: 'vendor-1',
        displayName: 'Midtown Hosts',
        commissionBps: 800,
        stripeAccountId: 'acct_vendor_123',
        onboardingStatus: 'active',
        entity: Entity.VENDOR_SERVICES,
      },
      patch: boundPatch,
    });
    (db.pointTransaction.findMany as any).mockResolvedValueOnce([{ type: 'earn', amount: 1000 }]);
    (db.booking.create as any).mockImplementationOnce(({ data }: any) => ({
      id: 'booking-1',
      userId: 'user-1',
      entity: data.entity,
      status: data.status,
      priceCents: data.priceCents,
      platformFeeCents: data.platformFeeCents,
      currency: data.currency,
      stripeSessionId: null,
      stripePaymentIntentId: null,
      stripeTransferDestination: data.stripeTransferDestination,
      ictJti: null,
      scheduledFor: data.scheduledFor,
      completedAt: null,
      metadata: data.metadata,
      createdAt: new Date('2026-05-03T19:00:00.000Z'),
      updatedAt: new Date('2026-05-03T19:00:00.000Z'),
      service: { id: 'svc-1', title: 'VIP Arrival', description: 'Door-to-table escort', durationMins: 90, status: 'active', patch: boundPatch },
      vendor: { id: 'vendor-1', displayName: 'Midtown Hosts' },
    }));
    stripeCheckoutSessionsCreate.mockResolvedValueOnce({ id: 'cs_booking_1', url: 'https://checkout.stripe.test/pay/cs_booking_1' });
    (db.booking.update as any).mockImplementationOnce(({ data }: any) => ({
      id: 'booking-1',
      userId: 'user-1',
      entity: Entity.VENDOR_SERVICES,
      status: 'pending',
      priceCents: 14000,
      platformFeeCents: 1120,
      currency: 'USD',
      stripeSessionId: data.stripeSessionId,
      stripePaymentIntentId: null,
      stripeTransferDestination: 'acct_vendor_123',
      ictJti: null,
      scheduledFor: new Date('2026-05-03T20:00:00.000Z'),
      completedAt: null,
      metadata: data.metadata,
      createdAt: new Date('2026-05-03T19:00:00.000Z'),
      updatedAt: new Date('2026-05-03T19:01:00.000Z'),
      service: { id: 'svc-1', title: 'VIP Arrival', description: 'Door-to-table escort', durationMins: 90, status: 'active', patch: boundPatch },
      vendor: { id: 'vendor-1', displayName: 'Midtown Hosts' },
    }));

    const caller = createAuthenticatedCaller('user-1', 'guest@test.com');
    const result = await caller.booking.createCheckout({
      serviceId: 'svc-1',
      scheduledFor: '2026-05-03T20:00:00.000Z',
      usePoints: true,
    });

    expect(db.booking.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'pending',
        entity: Entity.VENDOR_SERVICES,
        priceCents: 14000,
        platformFeeCents: 1120,
        stripeTransferDestination: 'acct_vendor_123',
      }),
      select: expect.any(Object),
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      payment_intent_data: expect.objectContaining({
        application_fee_amount: 1120,
        transfer_data: { destination: 'acct_vendor_123' },
        metadata: expect.objectContaining({
          bookingId: 'booking-1',
          entity: Entity.VENDOR_SERVICES,
          pointsToRedeem: '1000',
          finalChargeCents: '14000',
        }),
      }),
    }));
    expect(result.moneyFlow).toEqual(expect.objectContaining({
      entity: Entity.VENDOR_SERVICES,
      grossCents: 14000,
      applicationFeeAmount: 1120,
      providerPayoutEstimateCents: 12880,
      transferDestination: 'acct_vendor_123',
      pointsToRedeem: 1000,
    }));
  });

  it('lists the authenticated user bookings and preserves patch linkage', async () => {
    (db.booking.findMany as any).mockResolvedValueOnce([
      {
        id: 'booking-1',
        userId: 'user-1',
        status: 'confirmed',
        priceCents: 15000,
        platformFeeCents: 1200,
        currency: 'USD',
        stripePaymentIntentId: null,
        ictJti: 'ict-1',
        scheduledFor: new Date('2026-04-23T20:00:00.000Z'),
        completedAt: null,
        metadata: { partySize: 4 },
        createdAt: new Date('2026-04-23T19:00:00.000Z'),
        updatedAt: new Date('2026-04-23T19:00:00.000Z'),
        service: {
          id: 'svc-1',
          title: 'VIP Arrival',
          description: 'Door-to-table escort',
          durationMins: 90,
          status: 'active',
          patch: boundPatch,
        },
        vendor: { id: 'vendor-1', displayName: 'Midtown Hosts' },
      },
    ]);

    const caller = createAuthenticatedCaller('user-1', 'guest@test.com');
    const result = await caller.booking.listMine({ limit: 10 });

    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0].service.patch).toEqual(expect.objectContaining({ id: 'patch-1' }));
  });

  it('cancels a user booking and appends cancellation metadata', async () => {
    (db.booking.findUnique as any).mockResolvedValueOnce({
      id: 'booking-1',
      userId: 'user-1',
      status: 'confirmed',
      priceCents: 15000,
      platformFeeCents: 1200,
      currency: 'USD',
      stripePaymentIntentId: null,
      ictJti: 'ict-1',
      scheduledFor: null,
      completedAt: null,
      metadata: { partySize: 4 },
      createdAt: new Date('2026-04-23T19:00:00.000Z'),
      updatedAt: new Date('2026-04-23T19:00:00.000Z'),
      service: {
        id: 'svc-1',
        title: 'VIP Arrival',
        description: 'Door-to-table escort',
        durationMins: 90,
        status: 'active',
        patch: boundPatch,
      },
      vendor: { id: 'vendor-1', displayName: 'Midtown Hosts' },
    });
    (db.booking.update as any).mockImplementationOnce(({ data }: any) => ({
      id: 'booking-1',
      userId: 'user-1',
      status: data.status,
      priceCents: 15000,
      platformFeeCents: 1200,
      currency: 'USD',
      stripePaymentIntentId: null,
      ictJti: 'ict-1',
      scheduledFor: null,
      completedAt: null,
      metadata: data.metadata,
      createdAt: new Date('2026-04-23T19:00:00.000Z'),
      updatedAt: new Date('2026-04-23T19:05:00.000Z'),
      service: {
        id: 'svc-1',
        title: 'VIP Arrival',
        description: 'Door-to-table escort',
        durationMins: 90,
        status: 'active',
        patch: boundPatch,
      },
      vendor: { id: 'vendor-1', displayName: 'Midtown Hosts' },
    }));

    const caller = createAuthenticatedCaller('user-1', 'guest@test.com');
    const result = await caller.booking.cancel({ bookingId: 'booking-1', reason: 'Plans changed' });

    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data: expect.objectContaining({ status: 'canceled' }),
      select: expect.any(Object),
    });
    expect(result.alreadyCanceled).toBe(false);
    expect(result.booking.status).toBe('canceled');
    expect((result.booking.metadata as any).cancellation.reason).toBe('Plans changed');
  });
});