/**
 * Group Events router tests — host create/upsert, open vs approval join,
 * guest + host list shapes, approve/decline, and auth gating.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../lib/db';
import { createAuthenticatedCaller, createPublicCaller } from '../__tests__/helpers';
import { resetRateLimitBucketsForTests } from './trpc';

const HOST = 'host-1';
const GUEST = 'guest-1';
const SLUG = 'sunset-loft-9x2';

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SLUG,
    hostId: HOST,
    title: 'Sunset Loft',
    groupType: 'friends',
    tier: 'green',
    timing: 'now',
    scheduledDate: null,
    location: null,
    theme: null,
    instagramHandle: null,
    allowNearbyOffers: true,
    approvalMode: 'open',
    createdAt: new Date('2026-07-06T18:00:00.000Z'),
    ...overrides,
  };
}

describe('groupEvents router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitBucketsForTests();
  });

  it('create upserts an event for the host and returns the mapped shape', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(null);
    (db.groupEvent.upsert as any).mockImplementationOnce(({ create }: any) =>
      eventRow({ ...create }),
    );

    const caller = createAuthenticatedCaller(HOST);
    const res = await caller.groupEvents.create({ id: SLUG, title: 'Sunset Loft', groupType: 'friends' });

    expect(res).toMatchObject({ id: SLUG, hostId: HOST, approvalMode: 'open', createdAt: expect.any(String) });
    expect(db.groupEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ id: SLUG, hostId: HOST }) }),
    );
  });

  it('create rejects a slug already owned by another host', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ hostId: 'someone-else' }));
    const caller = createAuthenticatedCaller(HOST);
    await expect(
      caller.groupEvents.create({ id: SLUG, title: 'X', groupType: 'friends' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('join on an open event marks the guest joined', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ approvalMode: 'open' }));
    (db.groupEventGuest.upsert as any).mockImplementationOnce(({ create }: any) => ({ status: create.status }));

    const caller = createAuthenticatedCaller(GUEST);
    const res = await caller.groupEvents.join({ eventId: SLUG });

    expect(res).toEqual({ status: 'joined' });
  });

  it('join on an approval event marks the guest pending', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ approvalMode: 'approval' }));
    (db.groupEventGuest.upsert as any).mockImplementationOnce(({ create }: any) => ({ status: create.status }));

    const caller = createAuthenticatedCaller(GUEST);
    const res = await caller.groupEvents.join({ eventId: SLUG });

    expect(res).toEqual({ status: 'pending' });
  });

  it('join on a missing event throws NOT_FOUND', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(null);
    const caller = createAuthenticatedCaller(GUEST);
    await expect(caller.groupEvents.join({ eventId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('re-join keeps a previously declined guest declined (no revive to pending)', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ approvalMode: 'approval' }));
    // update: {} means the existing declined row is returned untouched.
    (db.groupEventGuest.upsert as any).mockResolvedValueOnce({ status: 'declined' });

    const caller = createAuthenticatedCaller(GUEST);
    const res = await caller.groupEvents.join({ eventId: SLUG });

    expect(res).toEqual({ status: 'declined' });
    expect(db.groupEventGuest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
  });

  it('guests returns the joined list with initials fallback for a member', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow());
    (db.groupEventGuest.findUnique as any).mockResolvedValueOnce({ userId: GUEST, status: 'joined' });
    (db.groupEventGuest.findMany as any).mockResolvedValueOnce([
      { userId: GUEST, status: 'joined', message: null, createdAt: new Date('2026-07-06T18:05:00.000Z'),
        user: { id: GUEST, name: 'Ada Lovelace', profileImage: null } },
    ]);

    const caller = createAuthenticatedCaller(GUEST);
    const res = await caller.groupEvents.guests({ eventId: SLUG });

    expect(res.count).toBe(1);
    expect(res.guests[0]).toMatchObject({ userId: GUEST, name: 'Ada Lovelace', initials: 'AL', status: 'joined' });
  });

  it('guests rejects a non-member caller with FORBIDDEN', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ hostId: HOST }));
    (db.groupEventGuest.findUnique as any).mockResolvedValueOnce(null);

    const caller = createAuthenticatedCaller('stranger');
    await expect(caller.groupEvents.guests({ eventId: SLUG })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.groupEventGuest.findMany).not.toHaveBeenCalled();
  });

  it('guests allows the host without a membership row', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ hostId: HOST }));
    (db.groupEventGuest.findMany as any).mockResolvedValueOnce([]);

    const caller = createAuthenticatedCaller(HOST);
    const res = await caller.groupEvents.guests({ eventId: SLUG });

    expect(res.count).toBe(0);
    expect(db.groupEventGuest.findUnique).not.toHaveBeenCalled();
  });

  it('host returns joined and pending guests split, host-only', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow());
    (db.groupEventGuest.findMany as any).mockResolvedValueOnce([
      { userId: 'g-joined', status: 'joined', message: null, createdAt: new Date('2026-07-06T18:05:00.000Z'),
        user: { id: 'g-joined', name: 'Grace Hopper', profileImage: null } },
      { userId: 'g-pending', status: 'pending', message: 'let me in', createdAt: new Date('2026-07-06T18:06:00.000Z'),
        user: { id: 'g-pending', name: 'Alan', profileImage: null } },
    ]);

    const caller = createAuthenticatedCaller(HOST);
    const res = await caller.groupEvents.host({ eventId: SLUG });

    expect(res.guests).toHaveLength(1);
    expect(res.pending).toHaveLength(1);
    expect(res.pending[0]).toMatchObject({ userId: 'g-pending', message: 'let me in' });
  });

  it('host rejects a non-host caller with FORBIDDEN', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ hostId: HOST }));
    const caller = createAuthenticatedCaller('intruder');
    await expect(caller.groupEvents.host({ eventId: SLUG })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('decide approve flips a pending guest to joined', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ hostId: HOST }));
    (db.groupEventGuest.updateMany as any).mockResolvedValueOnce({ count: 1 });

    const caller = createAuthenticatedCaller(HOST);
    const res = await caller.groupEvents.decide({ eventId: SLUG, userId: GUEST, decision: 'approve' });

    expect(res).toEqual({ userId: GUEST, status: 'joined' });
    expect(db.groupEventGuest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'joined' } }),
    );
  });

  it('decide throws NOT_FOUND when the guest row is missing', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ hostId: HOST }));
    (db.groupEventGuest.updateMany as any).mockResolvedValueOnce({ count: 0 });
    const caller = createAuthenticatedCaller(HOST);
    await expect(
      caller.groupEvents.decide({ eventId: SLUG, userId: 'ghost', decision: 'decline' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('setApprovalMode updates the mode for the host', async () => {
    (db.groupEvent.findUnique as any).mockResolvedValueOnce(eventRow({ hostId: HOST }));
    (db.groupEvent.update as any).mockResolvedValueOnce(eventRow({ approvalMode: 'approval' }));

    const caller = createAuthenticatedCaller(HOST);
    const res = await caller.groupEvents.setApprovalMode({ eventId: SLUG, approvalMode: 'approval' });

    expect(res).toEqual({ eventId: SLUG, approvalMode: 'approval' });
  });

  it('rejects unauthenticated callers', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.groupEvents.create({ id: SLUG, title: 'X', groupType: 'friends' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
