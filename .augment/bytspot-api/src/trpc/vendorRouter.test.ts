import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Entity } from '@prisma/client';
import { db } from '../lib/db';
import { config } from '../config';
import { createAuthenticatedCaller, createPublicCaller } from '../__tests__/helpers';

const stripeAccountsCreate = vi.hoisted(() => vi.fn());
const stripeAccountsRetrieve = vi.hoisted(() => vi.fn());
const stripeAccountLinksCreate = vi.hoisted(() => vi.fn());
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(function StripeMock() {
    return {
      accounts: { create: stripeAccountsCreate, retrieve: stripeAccountsRetrieve },
      accountLinks: { create: stripeAccountLinksCreate },
    };
  }),
}));

const boundPatch = {
  id: 'patch-1',
  uid: '04A1B2C3D4E5F6',
  tagType: 'NTAG424_DNA',
  label: 'VIP Table Patch',
  readCounter: 9,
  status: 'bound',
  bindingType: 'service',
  bindingId: 'svc-1',
  confirmedAt: new Date('2026-05-03T12:00:00.000Z'),
  updatedAt: new Date('2026-05-03T12:05:00.000Z'),
};

const activeService = {
  id: 'svc-1',
  vendorId: 'vendor-1',
  title: 'VIP Arrival',
  description: 'Door-to-table escort with patch verified access',
  priceCents: 15000,
  currency: 'USD',
  durationMins: 90,
  status: 'active',
  createdAt: new Date('2026-05-03T11:00:00.000Z'),
  updatedAt: new Date('2026-05-03T12:10:00.000Z'),
  vendor: {
    id: 'vendor-1',
    displayName: 'Midtown Hosts',
    onboardingStatus: 'active',
    commissionBps: 800,
  },
  patch: boundPatch,
};

const vendorProfile = {
  id: 'vendor-1',
  userId: 'user-1',
  entity: Entity.VENDOR_SERVICES,
  displayName: 'Midtown Hosts',
  legalName: 'Midtown Hosts LLC',
  stripeAccountId: null,
  onboardingStatus: 'pending',
  commissionBps: 800,
  metadata: null,
  updatedAt: new Date('2026-05-03T12:10:00.000Z'),
};

const pendingAccount = {
  id: 'acct_123',
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: false,
  requirements: { currently_due: ['external_account'], past_due: [], disabled_reason: null },
};

const activeAccount = {
  id: 'acct_123',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  requirements: { currently_due: [], past_due: [], disabled_reason: null },
};

describe('vendor router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeAccountsCreate.mockReset();
    stripeAccountsRetrieve.mockReset();
    stripeAccountLinksCreate.mockReset();
    config.stripeSecretKey = '';
    process.env.NODE_ENV = 'development';
  });

  it('creates an Express account and onboarding link for a new vendor profile', async () => {
    config.stripeSecretKey = 'sk_test_transaction_metadata';
    (db.vendor.findFirst as any).mockResolvedValueOnce(null);
    (db.vendor.create as any).mockResolvedValueOnce(vendorProfile);
    stripeAccountsCreate.mockResolvedValueOnce(pendingAccount);
    (db.vendor.update as any).mockImplementationOnce(({ data }: any) => ({
      ...vendorProfile,
      stripeAccountId: data.stripeAccountId,
      onboardingStatus: data.onboardingStatus,
      metadata: data.metadata,
    }));
    stripeAccountLinksCreate.mockResolvedValueOnce({ url: 'https://connect.stripe.test/onboard', expires_at: 1777777777 });

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.startOnboarding({ displayName: 'Midtown Hosts', legalName: 'Midtown Hosts LLC' });

    expect(stripeAccountsCreate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'express',
      email: 'owner@test.com',
      metadata: expect.objectContaining({ vendorId: 'vendor-1', entity: Entity.VENDOR_SERVICES }),
    }));
    expect(stripeAccountLinksCreate).toHaveBeenCalledWith(expect.objectContaining({
      account: 'acct_123',
      type: 'account_onboarding',
      refresh_url: 'http://localhost:3000/provider/connect/refresh',
      return_url: 'http://localhost:3000/provider/connect/return',
    }));
    expect(result.url).toBe('https://connect.stripe.test/onboard');
    expect(result.vendor.stripeAccountId).toBe('acct_123');
    expect(result.vendor.onboardingStatus).toBe('pending');
  });

  it('syncs Connect readiness into the vendor onboarding status', async () => {
    config.stripeSecretKey = 'sk_test_transaction_metadata';
    (db.vendor.findUnique as any).mockResolvedValueOnce({ ...vendorProfile, stripeAccountId: 'acct_123' });
    stripeAccountsRetrieve.mockResolvedValueOnce(activeAccount);
    (db.vendor.update as any).mockImplementationOnce(({ data }: any) => ({
      ...vendorProfile,
      stripeAccountId: data.stripeAccountId,
      onboardingStatus: data.onboardingStatus,
      metadata: data.metadata,
    }));

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.syncOnboarding({ vendorId: 'vendor-1' });

    expect(stripeAccountsRetrieve).toHaveBeenCalledWith('acct_123');
    expect(db.vendor.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'vendor-1' },
      data: expect.objectContaining({ onboardingStatus: 'active' }),
    }));
    expect(result.vendor.onboardingStatus).toBe('active');
    expect(result.account?.chargesEnabled).toBe(true);
  });

  it('updates vendor readiness from a Connect account webhook payload', async () => {
    (db.vendor.findUnique as any).mockResolvedValueOnce({ ...vendorProfile, stripeAccountId: 'acct_123' });
    (db.vendor.update as any).mockImplementationOnce(({ data }: any) => ({
      ...vendorProfile,
      stripeAccountId: data.stripeAccountId,
      onboardingStatus: data.onboardingStatus,
      metadata: data.metadata,
    }));

    const caller = createPublicCaller();
    const result = await caller.vendors.connectWebhook({ type: 'account.updated', data: { object: activeAccount } });

    expect(db.vendor.findUnique).toHaveBeenCalledWith({ where: { stripeAccountId: 'acct_123' }, select: expect.any(Object) });
    expect(result.vendor?.onboardingStatus).toBe('active');
  });

  it('searches active vendor services and exposes marketplace cash-flow estimates', async () => {
    (db.vendorService.findMany as any).mockResolvedValueOnce([activeService]);

    const caller = createPublicCaller();
    const result = await caller.vendors.search({ query: 'vip', limit: 5 });

    expect(db.vendorService.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: 'active' }),
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 5,
      select: expect.any(Object),
    });
    expect(result.services).toHaveLength(1);
    expect(result.services[0].patch).toEqual(expect.objectContaining({ id: 'patch-1' }));
    expect(result.services[0].cashFlow).toEqual({
      grossCents: 15000,
      platformFeeCents: 1200,
      providerPayoutEstimateCents: 13800,
      commissionBps: 800,
    });
  });

  it('resolves a bound physical patch to an active vendor service', async () => {
    (db.hardwarePatch.findUnique as any).mockResolvedValueOnce(boundPatch);
    (db.vendorService.findUnique as any).mockResolvedValueOnce(activeService);

    const caller = createPublicCaller();
    const result = await caller.vendors.getByPatch({ patchId: 'patch-1' });

    expect(db.hardwarePatch.findUnique).toHaveBeenCalledWith({
      where: { id: 'patch-1' },
      select: expect.any(Object),
    });
    expect(db.vendorService.findUnique).toHaveBeenCalledWith({
      where: { id: 'svc-1' },
      select: expect.any(Object),
    });
    expect(result.patch.uid).toBe('04A1B2C3D4E5F6');
    expect(result.service.id).toBe('svc-1');
  });

  it('rejects unbound patches without exposing inactive services', async () => {
    (db.hardwarePatch.findUnique as any).mockResolvedValueOnce({
      ...boundPatch,
      status: 'unbound',
      bindingType: null,
      bindingId: null,
    });

    const caller = createPublicCaller();
    await expect(caller.vendors.getByPatch({ uid: '04-a1-b2-c3-d4-e5-f6' })).rejects.toThrow(
      'No active vendor service is bound to this patch',
    );
    expect(db.vendorService.findUnique).not.toHaveBeenCalled();
  });
});