import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db';
import { createAuthenticatedCaller, createPublicCaller } from '../__tests__/helpers';
import { resetRateLimitBucketsForTests } from './trpc';
import { uploadPartyImage } from '../lib/cloudinary';

const HOST = 'host-1';
const KEY = 'moment-12345678';
const FINGERPRINT = 'fingerprint-1';

function draft(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: KEY,
    templateId: 'listening-party' as const,
    title: 'First Listen',
    tagline: 'One moment. Your people.',
    startsAt: '2026-08-10T20:00:00Z',
    venueName: 'The Loft',
    capacity: 80,
    accessMode: 'free-rsvp' as const,
    requiredMembershipTier: 'green' as const,
    audienceCircleIds: ['circle-1'],
    itinerary: [{ title: 'Doors open', offsetMinutes: 0 }],
    ticketTiers: [],
    cohosts: [{ email: 'door@bytspot.com', role: 'door' as const }],
    templateConfig: { kind: 'listening-party' as const, format: 'listening-session' as const },
    source: 'host-studio' as const,
    ...overrides,
  };
}

function party(overrides: Record<string, unknown> = {}) {
  return {
    id: 'party-1', hostId: HOST, idempotencyKey: KEY,
    draftFingerprint: FINGERPRINT, status: 'draft', passCode: null,
    templateId: 'listening-party', title: 'First Listen', tagline: 'One moment. Your people.',
    startsAt: new Date('2026-08-10T20:00:00Z'), venueName: 'The Loft', capacity: 80,
    accessMode: 'free-rsvp', requiredMembershipTier: 'green', audienceCircleIds: ['circle-1'],
    coverImageUrl: null, photoUrls: [],
    itinerary: [{ title: 'Doors open', offsetMinutes: 0 }],
    templateConfig: { kind: 'listening-party', format: 'listening-session' },
    ...overrides,
  };
}

describe('events party procedures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitBucketsForTests();
  });

  it('creates an immutable authenticated draft with canonical membership and teammate roles', async () => {
    (db.party.upsert as any).mockImplementationOnce(({ create }: any) => party({ ...create, draftFingerprint: create.draftFingerprint }));
    const result = await createAuthenticatedCaller(HOST).events.drafts.create(draft());

    expect(result).toEqual({ id: 'party-1', status: 'draft' });
    expect(db.party.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ hostId: HOST, requiredMembershipTier: 'green', cohosts: [{ email: 'door@bytspot.com', role: 'door' }], templateConfig: { kind: 'listening-party', format: 'listening-session' } }),
      update: {},
    }));
  });

  it('rejects unauthenticated draft creation', async () => {
    await expect(createPublicCaller().events.drafts.create(draft())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a ticket tier that bypasses the party membership gate', async () => {
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({
      accessMode: 'paid-ticket', requiredMembershipTier: 'black',
      ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
    }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.party.upsert).not.toHaveBeenCalled();
  });

  it('rejects mismatched template configuration and hidden Pop-Ups without approval', async () => {
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({
      templateConfig: { kind: 'private-party', guestPolicy: 'named-guests' },
    }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({
      templateId: 'pop-up', templateConfig: { kind: 'pop-up', locationDisclosure: 'after-approval' },
    }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.party.upsert).not.toHaveBeenCalled();
  });

  it('rejects owner role injection and self-assignment', async () => {
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({
      cohosts: [{ email: 'host@bytspot.com', role: 'owner' }],
    }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(createAuthenticatedCaller(HOST, 'host@bytspot.com').events.drafts.create(draft({
      cohosts: [{ email: 'host@bytspot.com', role: 'cohost' }],
    }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects reuse of an idempotency key for a different draft', async () => {
    (db.party.upsert as any).mockResolvedValueOnce(party());
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft())).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('uploads owner-controlled cover and album media to deterministic Cloudinary slots', async () => {
    const dataUri = 'data:image/jpeg;base64,QUJD';
    (db.party.findUnique as any)
      .mockResolvedValueOnce(party({ coverImageUrl: 'https://old.example/cover.jpg', photoUrls: ['https://old.example/photo.jpg'] }))
      .mockResolvedValueOnce(party())
      .mockResolvedValueOnce(party({ photoUrls: [] }));

    const caller = createAuthenticatedCaller(HOST);
    await caller.events.media.reset({ partyId: 'party-1' });
    const cover = await caller.events.media.upload({ partyId: 'party-1', kind: 'cover', dataUri });
    const photo = await caller.events.media.upload({ partyId: 'party-1', kind: 'album', index: 0, dataUri });

    expect(cover.url).toContain('/bytspot/parties/party-1/cover.jpg');
    expect(photo.url).toContain('/bytspot/parties/party-1/album-0.jpg');
    expect(uploadPartyImage).toHaveBeenNthCalledWith(1, dataUri, 'bytspot/parties/party-1/cover');
    expect(db.party.update).toHaveBeenCalledWith({ where: { id: 'party-1' }, data: { coverImageUrl: null, photoUrls: [] } });
    expect(db.party.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { photoUrls: [photo.url] } }));
  });

  it('rejects Party media uploads from non-owners and after publication', async () => {
    const input = { partyId: 'party-1', kind: 'cover' as const, dataUri: 'data:image/png;base64,QUJD' };
    (db.party.findUnique as any).mockResolvedValueOnce(party());
    await expect(createAuthenticatedCaller('intruder').events.media.upload(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published' }));
    await expect(createAuthenticatedCaller(HOST).events.media.upload(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published' }));
    await expect(createAuthenticatedCaller(HOST).events.media.reset({ partyId: 'party-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns the original draft when the same create request is replayed', async () => {
    let stored: Record<string, unknown> | undefined;
    (db.party.upsert as any).mockImplementation(({ create }: any) => {
      stored ??= party({ ...create, draftFingerprint: create.draftFingerprint });
      return stored;
    });
    const caller = createAuthenticatedCaller(HOST);

    const first = await caller.events.drafts.create(draft());
    const replay = await caller.events.drafts.create(draft());

    expect(replay).toEqual(first);
    expect(db.party.upsert).toHaveBeenCalledTimes(2);
  });

  it('publishes only for the owner with the matching idempotency key', async () => {
    (db.party.findUnique as any)
      .mockResolvedValueOnce(party())
      .mockResolvedValueOnce(party({ status: 'published', passCode: 'PARTY826' }));
    (db.party.updateMany as any).mockResolvedValueOnce({ count: 1 });

    const result = await createAuthenticatedCaller(HOST).events.publish({ partyId: 'party-1', idempotencyKey: KEY });

    expect(result).toEqual({ id: 'party-1', status: 'published', shareUrl: 'https://bytspot.app/party/party-1', passCode: 'PARTY826' });
    expect(db.party.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ hostId: HOST, status: 'draft', idempotencyKey: KEY }),
      data: expect.objectContaining({ status: 'published', passCode: expect.stringMatching(/^[A-Z2-9]{8}$/) }),
    }));
    expect(db.groupEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'party-1' },
      create: expect.objectContaining({ id: 'party-1', title: 'First Listen', tier: 'green', approvalMode: 'open' }),
    }));
    expect(db.partyTouchpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { partyId_kind: { partyId: 'party-1', kind: 'digital' } },
      create: expect.objectContaining({ partyId: 'party-1', kind: 'digital', reference: expect.stringMatching(/^p1_[A-Za-z0-9_-]+$/), lifecyclePolicy: expect.objectContaining({ before: { action: 'rsvp' } }) }),
    }));
  });

  it('rejects publish by a non-owner or with a mismatched key', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party());
    await expect(createAuthenticatedCaller('intruder').events.publish({ partyId: 'party-1', idempotencyKey: KEY })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    (db.party.findUnique as any).mockResolvedValueOnce(party());
    await expect(createAuthenticatedCaller(HOST).events.publish({ partyId: 'party-1', idempotencyKey: 'different-123456' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns the original Party Pass when publish is replayed', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published', passCode: 'LAUGH826' }));
    const result = await createAuthenticatedCaller(HOST).events.publish({ partyId: 'party-1', idempotencyKey: KEY });

    expect(result.passCode).toBe('LAUGH826');
    expect(db.party.updateMany).not.toHaveBeenCalled();
    expect(db.groupEvent.upsert).toHaveBeenCalled();
  });

  it('returns the exact published Host Studio Party as a public invite', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', passCode: 'PARTY826', host: { name: 'Avery Parker' },
      coverImageUrl: 'https://res.cloudinary.com/bytspot/image/upload/cover.jpg',
      photoUrls: ['https://res.cloudinary.com/bytspot/image/upload/album-0.jpg'],
    }));
    (db.groupEventGuest.count as any).mockResolvedValueOnce(3);

    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({
      id: 'party-1', source: 'host-studio-party', title: 'First Listen', inviteNote: 'One moment. Your people.',
      tier: 'green', participantCount: 3, capacity: 80, accessMode: 'free-rsvp',
      hostName: 'Avery Parker', locationLabel: 'The Loft', activityHighlights: ['Doors open'],
      audienceCircle: 'Selected Circles', privacyStatus: 'privateInvite', requiresApproval: false,
      heroImageURL: 'https://res.cloudinary.com/bytspot/image/upload/cover.jpg',
      photoURLs: ['https://res.cloudinary.com/bytspot/image/upload/album-0.jpg'],
    });
  });

  it('redacts a Pop-Up location from every public Party Pass projection', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      templateId: 'pop-up', templateConfig: { kind: 'pop-up', locationDisclosure: 'after-approval' }, status: 'published', host: { name: 'Avery Parker' },
    }));
    (db.groupEventGuest.count as any).mockResolvedValueOnce(0);

    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({ locationLabel: 'Location shared after approval', locationDisclosure: 'after-approval' });
  });

  it('resolves only the configured pre-party action for an active published touchpoint', async () => {
    (db.partyTouchpoint.findUnique as any).mockResolvedValueOnce({
      partyId: 'party-1', reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'active',
      lifecyclePolicy: { version: 1, before: { action: 'ticket' }, atDoor: { action: 'unavailable' }, during: { action: 'unavailable' }, after: { action: 'unavailable' } },
      party: party({ status: 'published', startsAt: new Date('2099-08-10T20:00:00Z') }),
    });

    const result = await createPublicCaller().events.pass.resolve({ touchpointRef: 'p1_0123456789abcdefghijklmnop' });

    expect(result).toEqual(expect.objectContaining({ partyId: 'party-1', lifecycle: 'before', action: 'ticket', guest: { status: 'anonymous', canStartPrimaryAction: true, accessGranted: false } }));
  });

  it('fails closed for inactive touchpoints', async () => {
    (db.partyTouchpoint.findUnique as any).mockResolvedValueOnce({ partyId: 'party-1', reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'inactive', lifecyclePolicy: {}, party: party({ status: 'published' }) });
    await expect(createPublicCaller().events.pass.resolve({ touchpointRef: 'p1_0123456789abcdefghijklmnop' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not expose drafts through the public invite route', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party());
    await expect(createPublicCaller().events.invite({ partyId: 'party-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});