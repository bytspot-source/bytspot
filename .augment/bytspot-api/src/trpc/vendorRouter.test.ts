import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Entity } from '@prisma/client';
import { db } from '../lib/db';
import { config } from '../config';
import { createAuthenticatedCaller, createPublicCaller } from '../__tests__/helpers';

const stripeAccountsCreate = vi.hoisted(() => vi.fn());
const stripeAccountsRetrieve = vi.hoisted(() => vi.fn());
const stripeAccountLinksCreate = vi.hoisted(() => vi.fn());
const TEST_STRIPE_SECRET = `sk_${'test'}_transaction_metadata`;
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
  createdAt: new Date('2026-05-03T11:55:00.000Z'),
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

const activeBooking = {
  id: 'booking-1',
  serviceId: 'svc-1',
  vendorId: 'vendor-1',
  userId: 'guest-1',
  status: 'confirmed',
  priceCents: 15000,
  platformFeeCents: 1200,
  currency: 'USD',
  scheduledFor: new Date('2026-05-04T16:00:00.000Z'),
  completedAt: null,
  createdAt: new Date('2026-05-03T16:00:00.000Z'),
  updatedAt: new Date('2026-05-03T16:05:00.000Z'),
  service: {
    id: 'svc-1',
    title: 'VIP Arrival',
    priceCents: 15000,
    currency: 'USD',
    durationMins: 90,
    patch: boundPatch,
  },
  user: { id: 'guest-1', name: 'Taylor Guest', email: 'guest@test.com' },
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

const delegatedVendorProfile = { ...vendorProfile, userId: 'owner-user' };

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
    config.stripeSecretKey = TEST_STRIPE_SECRET;
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
    config.stripeSecretKey = TEST_STRIPE_SECRET;
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

  it('lists services owned by the authenticated vendor', async () => {
    (db.vendor.findFirst as any).mockResolvedValueOnce(vendorProfile);
    (db.vendorService.findMany as any).mockResolvedValueOnce([activeService]);

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.listServices({ status: 'all', limit: 10 });

    expect(db.vendorService.findMany).toHaveBeenCalledWith({
      where: { vendorId: 'vendor-1' },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      select: expect.any(Object),
    });
    expect(result.vendor.id).toBe('vendor-1');
    expect(result.services[0].id).toBe('svc-1');
  });

  it('creates a vendor service owned by the authenticated vendor', async () => {
    const createdService = { ...activeService, id: 'svc-new', title: 'Garage Parking', description: 'Secure indoor parking near the venue', priceCents: 2500, durationMins: 60, patch: null };
    (db.vendor.findFirst as any).mockResolvedValueOnce(vendorProfile);
    (db.vendorService.create as any).mockResolvedValueOnce(createdService);

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.createService({
      title: 'Garage Parking',
      description: 'Secure indoor parking near the venue',
      priceCents: 2500,
      durationMins: 60,
      status: 'active',
    });

    expect(db.vendorService.create).toHaveBeenCalledWith({
      data: {
        vendorId: 'vendor-1',
        title: 'Garage Parking',
        description: 'Secure indoor parking near the venue',
        priceCents: 2500,
        currency: 'USD',
        durationMins: 60,
        status: 'active',
      },
      select: expect.any(Object),
    });
    expect(result.service.id).toBe('svc-new');
    expect(result.service.cashFlow.providerPayoutEstimateCents).toBe(2300);
  });

  it('allows managers to manage catalog without exposing owner cash-flow fields', async () => {
    const createdService = { ...activeService, id: 'svc-manager', vendorId: 'vendor-1', patch: null };
    (db.vendor.findUnique as any).mockResolvedValueOnce(delegatedVendorProfile);
    (db.vendorMember.findUnique as any).mockResolvedValueOnce({ role: 'MANAGER' });
    (db.vendorService.create as any).mockResolvedValueOnce(createdService);

    const caller = createAuthenticatedCaller('manager-1', 'manager@test.com', {
      vendorRoles: [{ vendorId: 'vendor-1', role: 'manager', groups: ['bytspot:vendor:vendor-1:manager'] }],
    });
    const result = await caller.vendors.createService({
      vendorId: 'vendor-1',
      title: 'Managed Service',
      priceCents: 5000,
      status: 'active',
    });

    expect(result.providerRole).toBe('manager');
    expect(result.service.id).toBe('svc-manager');
    expect(result.service.cashFlow).toBeUndefined();
  });

  it('blocks staff from creating vendor services', async () => {
    (db.vendor.findUnique as any).mockResolvedValueOnce(delegatedVendorProfile);
    (db.vendorMember.findUnique as any).mockResolvedValueOnce({ role: 'STAFF' });

    const caller = createAuthenticatedCaller('staff-1', 'staff@test.com', {
      vendorRoles: [{ vendorId: 'vendor-1', role: 'staff', groups: ['bytspot:vendor:vendor-1:staff'] }],
    });

    await expect(caller.vendors.createService({ vendorId: 'vendor-1', title: 'Staff Service', priceCents: 5000 })).rejects.toThrow(
      'Create vendor services requires owner/manager vendor role',
    );
    expect(db.vendorService.create).not.toHaveBeenCalled();
  });

  it('lists bookings owned by the authenticated vendor', async () => {
    (db.vendor.findFirst as any).mockResolvedValueOnce(vendorProfile);
    (db.booking.findMany as any).mockResolvedValueOnce([activeBooking]);

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.listBookings({ limit: 25 });

    expect(db.booking.findMany).toHaveBeenCalledWith({
      where: { vendorId: 'vendor-1' },
      orderBy: [{ scheduledFor: 'desc' }, { createdAt: 'desc' }],
      take: 25,
      select: expect.any(Object),
    });
    expect(result.bookings[0]).toEqual(expect.objectContaining({
      id: 'booking-1',
      status: 'confirmed',
      startsAt: '2026-05-04T16:00:00.000Z',
      guest: expect.objectContaining({ displayName: 'Taylor Guest' }),
      cashFlow: expect.objectContaining({ providerPayoutEstimateCents: 13800 }),
    }));
  });

  it('allows staff to read bookings without owner financial cash-flow fields', async () => {
    (db.vendor.findUnique as any).mockResolvedValueOnce(delegatedVendorProfile);
    (db.vendorMember.findUnique as any).mockResolvedValueOnce({ role: 'STAFF' });
    (db.booking.findMany as any).mockResolvedValueOnce([activeBooking]);

    const caller = createAuthenticatedCaller('staff-1', 'staff@test.com', {
      vendorRoles: [{ vendorId: 'vendor-1', role: 'staff', groups: ['bytspot:vendor:vendor-1:staff'] }],
    });
    const result = await caller.vendors.listBookings({ vendorId: 'vendor-1', limit: 25 });

    expect(result.providerRole).toBe('staff');
    expect(result.bookings[0].id).toBe('booking-1');
    expect(result.bookings[0].cashFlow).toBeUndefined();
  });

  it('returns providerRole from syncOnboarding and blocks manager Stripe account sync', async () => {
    config.stripeSecretKey = TEST_STRIPE_SECRET;
    (db.vendor.findUnique as any).mockResolvedValueOnce({ ...delegatedVendorProfile, stripeAccountId: 'acct_123' });
    (db.vendorMember.findUnique as any).mockResolvedValueOnce({ role: 'MANAGER' });

    const caller = createAuthenticatedCaller('manager-1', 'manager@test.com', {
      vendorRoles: [{ vendorId: 'vendor-1', role: 'manager', groups: ['bytspot:vendor:vendor-1:manager'] }],
    });
    const result = await caller.vendors.syncOnboarding({ vendorId: 'vendor-1' });

    expect(result.providerRole).toBe('manager');
    expect(result.vendor.providerRole).toBe('manager');
    expect(result.account).toBeNull();
    expect(stripeAccountsRetrieve).not.toHaveBeenCalled();
  });

  it('blocks managers from owner-level Stripe Connect onboarding', async () => {
    config.stripeSecretKey = TEST_STRIPE_SECRET;
    (db.vendor.findUnique as any).mockResolvedValueOnce(delegatedVendorProfile);
    (db.vendorMember.findUnique as any).mockResolvedValueOnce({ role: 'MANAGER' });

    const caller = createAuthenticatedCaller('manager-1', 'manager@test.com', {
      vendorRoles: [{ vendorId: 'vendor-1', role: 'manager', groups: ['bytspot:vendor:vendor-1:manager'] }],
    });

    await expect(caller.vendors.startOnboarding({ vendorId: 'vendor-1' })).rejects.toThrow(
      'Stripe Connect onboarding requires owner vendor role',
    );
    expect(stripeAccountsCreate).not.toHaveBeenCalled();
  });

  it('updates owned vendor service metadata', async () => {
    const updatedService = {
      ...activeService,
      title: 'VIP Arrival Plus',
      description: 'Updated provider handoff',
      priceCents: 17500,
      durationMins: 120,
    };
    (db.vendorService.findUnique as any).mockResolvedValueOnce(activeService);
    (db.vendor.findUnique as any).mockResolvedValueOnce(vendorProfile);
    (db.vendorService.update as any).mockResolvedValueOnce(updatedService);

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.updateService({
      serviceId: 'svc-1',
      title: 'VIP Arrival Plus',
      description: 'Updated provider handoff',
      priceCents: 17500,
      durationMins: 120,
    });

    expect(db.vendorService.update).toHaveBeenCalledWith({
      where: { id: 'svc-1' },
      data: {
        title: 'VIP Arrival Plus',
        description: 'Updated provider handoff',
        priceCents: 17500,
        durationMins: 120,
      },
      select: expect.any(Object),
    });
    expect(result.service.title).toBe('VIP Arrival Plus');
    expect(result.service.cashFlow.grossCents).toBe(17500);
  });

  it('lists vendor-managed patches from service and vendor bindings', async () => {
    const vendorPatch = {
      ...boundPatch,
      id: 'patch-vendor',
      uid: '04A1B2C3D4E5F7',
      label: 'Main Entrance',
      bindingType: 'vendor',
      bindingId: 'vendor-1',
    };
    (db.vendor.findFirst as any).mockResolvedValueOnce(vendorProfile);
    (db.vendorService.findMany as any).mockResolvedValueOnce([{ id: 'svc-1', title: 'VIP Arrival', status: 'active', patchId: 'patch-1', patch: boundPatch }]);
    (db.hardwarePatch.findMany as any).mockResolvedValueOnce([vendorPatch]);

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.listPatches({ limit: 10 });

    expect(db.vendorService.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { vendorId: 'vendor-1' },
      select: expect.objectContaining({ patch: { select: expect.any(Object) } }),
    }));
    expect(db.hardwarePatch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { bindingType: 'vendor', bindingId: 'vendor-1', entity: Entity.VENDOR_SERVICES },
    }));
    expect(result.patches).toHaveLength(2);
    expect(result.patches[0]).toEqual(expect.objectContaining({ venueName: 'Midtown Hosts', url: expect.stringContaining('/p/') }));
    expect(result.patches.some((patch) => patch.serviceId === 'svc-1' && patch.serviceTitle === 'VIP Arrival')).toBe(true);
  });

  it('creates a live vendor patch and binds it to an owned service', async () => {
    (db.vendor.findFirst as any).mockResolvedValueOnce(vendorProfile);
    (db.vendorService.findUnique as any).mockResolvedValueOnce({ id: 'svc-1', vendorId: 'vendor-1', title: 'VIP Arrival', status: 'active', patchId: null });
    (db.hardwarePatch.create as any).mockResolvedValueOnce({ ...boundPatch, label: 'VIP Booth', createdAt: boundPatch.updatedAt });
    (db.vendorService.update as any).mockResolvedValueOnce({ ...activeService, patchId: 'patch-1' });

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.vendors.createPatch({ label: 'VIP Booth', serviceId: 'svc-1' });

    expect(db.hardwarePatch.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        label: 'VIP Booth',
        tagType: 'BYTSPOT_LINK',
        entity: Entity.VENDOR_SERVICES,
        status: 'bound',
        bindingType: 'service',
        bindingId: 'svc-1',
      }),
      select: expect.any(Object),
    }));
    expect(db.vendorService.update).toHaveBeenCalledWith({ where: { id: 'svc-1' }, data: { patchId: 'patch-1' } });
    expect(result.patch).toEqual(expect.objectContaining({ serviceId: 'svc-1', serviceTitle: 'VIP Arrival', url: expect.stringContaining('&service=svc-1') }));
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