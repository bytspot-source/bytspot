import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../lib/db';
import { createAuthenticatedCaller, createPublicCaller } from '../__tests__/helpers';
import { __resetICTKeysForTests, getActiveICTKid, signICT, verifyICT } from '../services/ictSigner';

const basePatch = {
  id: 'patch-1',
  uid: '04A1B2C3D4E5F6',
  tagType: 'NTAG424_DNA',
  sdmKeyRef: 'kms/key/patch-1',
  readCounter: 3,
  label: 'VIP Table Patch',
  status: 'bound',
  entity: 'VENDOR_SERVICES' as const,
  bindingType: 'service',
  bindingId: 'svc-1',
  confirmedAt: new Date('2026-04-23T15:00:00.000Z'),
  createdAt: new Date('2026-04-23T14:00:00.000Z'),
  updatedAt: new Date('2026-04-23T15:00:00.000Z'),
};

const originalNodeEnv = process.env.NODE_ENV;

describe('patch router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'development';
    __resetICTKeysForTests();
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    __resetICTKeysForTests();
  });

  it('creates a provisioned hardware patch with a normalized UID', async () => {
    (db.hardwarePatch.create as any).mockResolvedValueOnce({
      ...basePatch,
      status: 'unbound',
      entity: 'BYTSPOT_INC',
      bindingType: null,
      bindingId: null,
      confirmedAt: null,
      readCounter: 0,
    });

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.patch.create({
      uid: '04-a1:b2 c3-d4:e5:f6',
      label: 'VIP Table Patch',
      sdmKeyRef: 'kms/key/patch-1',
    });

    expect(db.hardwarePatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        uid: '04A1B2C3D4E5F6',
        status: 'unbound',
        entity: 'BYTSPOT_INC',
      }),
    });
    expect(result.uid).toBe('04A1B2C3D4E5F6');
    expect(db.complianceLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        procedure: 'patch.create',
        outcome: 'allow',
      }),
    });
  });

  it('confirms a service binding and links the vendor service to the patch', async () => {
    (db.hardwarePatch.findUnique as any).mockResolvedValueOnce({
      ...basePatch,
      status: 'unbound',
      bindingType: null,
      bindingId: null,
      entity: 'BYTSPOT_INC',
      confirmedAt: null,
    });
    (db.vendorService.findUnique as any).mockResolvedValueOnce({ id: 'svc-1', patchId: null });
    (db.vendorService.update as any).mockResolvedValueOnce({ id: 'svc-1', patchId: 'patch-1' });
    (db.hardwarePatch.update as any).mockResolvedValueOnce(basePatch);

    const caller = createAuthenticatedCaller('user-1', 'owner@test.com');
    const result = await caller.patch.confirmBinding({
      patchId: 'patch-1',
      bindingType: 'service',
      bindingId: 'svc-1',
    });

    expect(db.vendorService.update).toHaveBeenCalledWith({
      where: { id: 'svc-1' },
      data: { patchId: 'patch-1' },
    });
    expect(db.hardwarePatch.update).toHaveBeenCalledWith({
      where: { id: 'patch-1' },
      data: expect.objectContaining({
        bindingType: 'service',
        bindingId: 'svc-1',
        status: 'bound',
        entity: 'VENDOR_SERVICES',
      }),
    });
    expect(result.binding).toEqual({ type: 'service', id: 'svc-1' });
  });

  it('issues a short-lived ICT for a patch verification flow', async () => {
    (db.hardwarePatch.findUnique as any).mockResolvedValueOnce(basePatch);

    const caller = createAuthenticatedCaller('user-99', 'tapper@test.com');
    const result = await caller.patch.rotatingToken({
      patchId: 'patch-1',
      ttlSec: 90,
      device: { fingerprint: 'fp-1', platform: 'ios' },
    });

    const claims = verifyICT(result.token);
    expect(result.kid).toBe(getActiveICTKid());
    expect(result.expiresInSec).toBe(90);
    expect(claims.action).toBe('patch.tap');
    expect(claims.resource).toEqual({ type: 'patch', id: 'patch-1' });
    expect(claims.sub).toBe('user-99');
    expect(claims.uid).toBe('04A1B2C3D4E5F6');
  });

  it('keeps rotating tokens valid within the default 60 second skew window only', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-23T16:00:00.000Z'));
      (db.hardwarePatch.findUnique as any).mockResolvedValueOnce(basePatch);

      const caller = createAuthenticatedCaller('user-99', 'tapper@test.com');
      const result = await caller.patch.rotatingToken({
        patchId: 'patch-1',
        ttlSec: 45,
      });

      vi.setSystemTime(new Date('2026-04-23T16:01:15.000Z'));
      expect(() => verifyICT(result.token)).not.toThrow();

      vi.setSystemTime(new Date('2026-04-23T16:01:46.000Z'));
      expect(() => verifyICT(result.token)).toThrow(/expired/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('verifies a tap ICT and advances the patch read counter', async () => {
    const token = signICT({
      action: 'patch.tap',
      resource: { type: 'patch', id: 'patch-1' },
      uid: '04A1B2C3D4E5F6',
      entity: 'VENDOR_SERVICES',
    });
    (db.hardwarePatch.findUnique as any).mockResolvedValueOnce(basePatch);
    (db.hardwarePatch.update as any).mockResolvedValueOnce({ ...basePatch, readCounter: 4 });

    const caller = createPublicCaller();
    const result = await caller.patch.verifyTap({
      token,
      uid: '04A1B2C3D4E5F6',
      readCounter: 4,
    });

    expect(db.hardwarePatch.update).toHaveBeenCalledWith({
      where: { id: 'patch-1' },
      data: { readCounter: 4 },
    });
    expect(result.verified).toBe(true);
    expect(result.patch.readCounter).toBe(4);
    expect(result.binding).toEqual({ type: 'service', id: 'svc-1' });
  });
});