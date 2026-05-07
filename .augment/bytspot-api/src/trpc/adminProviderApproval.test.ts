import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db';
import { createAuthenticatedCaller, createPublicCaller } from '../__tests__/helpers';

const user = { id: 'user-1', email: 'provider@test.com', name: 'Provider Owner' };
const hostProfile = {
  id: 'host-1',
  userId: 'user-1',
  status: 'pending',
  currentStep: 10,
  onboardingData: null,
  submittedAt: new Date('2026-05-07T12:00:00.000Z'),
  approvedAt: null,
};
const vendor = {
  id: 'vendor-1',
  userId: 'user-1',
  displayName: 'Provider Test LLC',
  legalName: 'Provider Test LLC',
  stripeAccountId: 'acct_test',
  onboardingStatus: 'pending',
  metadata: null,
  updatedAt: new Date('2026-05-07T12:00:00.000Z'),
};

describe('admin provider approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.user.findUnique as any).mockResolvedValue(user);
    (db.hostProfile.findUnique as any).mockResolvedValue(hostProfile);
    (db.vendor.findFirst as any).mockResolvedValue(vendor);
    (db.hostProfile.update as any).mockImplementation(({ data }: any) => ({ ...hostProfile, ...data }));
    (db.vendor.update as any).mockImplementation(({ data }: any) => ({ ...vendor, ...data }));
  });

  it('lists pending provider applications for internal ops group members', async () => {
    (db.hostProfile.findMany as any).mockResolvedValueOnce([{
      ...hostProfile,
      updatedAt: new Date('2026-05-07T12:30:00.000Z'),
      user: { email: user.email, name: user.name, vendors: [vendor] },
    }]);

    const caller = createAuthenticatedCaller('ops-1', 'ops@test.com', { groups: ['INTERNAL_OPS'] });
    const result = await caller.admin.listPendingProviderApplications({ limit: 10 });

    expect(db.hostProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'pending' },
      take: 10,
    }));
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0].user.email).toBe('provider@test.com');
  });

  it('approves a pending HostProfile and activates the provider vendor workspace', async () => {
    const caller = createAuthenticatedCaller('admin-1', 'admin@test.com', { groups: ['BYTSPOT_ADMIN'] });
    const result = await caller.admin.approveProviderApplication({
      email: 'provider@test.com',
      markStripeConnectReady: true,
    });

    expect(db.hostProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
      data: expect.objectContaining({ status: 'approved', approvedAt: expect.any(Date) }),
    }));
    expect(db.vendor.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'vendor-1' },
      data: expect.objectContaining({ onboardingStatus: 'active' }),
    }));
    expect(result.host.status).toBe('approved');
    expect(result.vendor?.onboardingStatus).toBe('active');
    expect((result.vendor?.metadata as any).stripeConnect.payoutsEnabled).toBe(true);
    expect(result.sideEffects.sovereignShieldStateFlags).toContain('PROVIDER_ADMIN_APPROVAL');
  });

  it('requires authentication for approval', async () => {
    const caller = createPublicCaller();
    await expect(caller.admin.approveProviderApplication({
      userId: 'user-1',
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects authenticated users without admin approval groups', async () => {
    const caller = createAuthenticatedCaller('user-2', 'member@test.com', { groups: ['bytspot:user'] });
    await expect(caller.admin.approveProviderApplication({
      userId: 'user-1',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});