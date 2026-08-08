import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db';
import { createAuthenticatedCaller, createPublicCaller, createStripeWebhookCaller } from '../__tests__/helpers';
import { resetRateLimitBucketsForTests } from './trpc';
import { uploadPartyImage } from '../lib/cloudinary';
import { config } from '../config';

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
    cashDoorPriceCents: null,
    requiredMembershipTier: 'green' as const,
    audienceCircleIds: ['circle-1'],
    itinerary: [{ title: 'Doors open', offsetMinutes: 0 }],
    creatorLinks: [{ kind: 'music' as const, title: 'Listen now', url: 'https://music.example/first-listen' }],
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
    cashDoorPriceCents: null,
    coverImageUrl: null, photoUrls: [],
    creatorLinks: [{ kind: 'music', title: 'Listen now', url: 'https://music.example/first-listen' }],
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
      create: expect.objectContaining({ hostId: HOST, requiredMembershipTier: 'green', creatorLinks: [{ kind: 'music', title: 'Listen now', url: 'https://music.example/first-listen' }], cohosts: [{ email: 'door@bytspot.com', role: 'door' }], templateConfig: { kind: 'listening-party', format: 'listening-session' } }),
      update: {},
    }));
  });

  it('rejects non-HTTPS, credentialed, duplicate, or excessive creator links', async () => {
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({
      creatorLinks: [{ kind: 'music', title: 'Unsafe', url: 'http://music.example/release' }],
    }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({
      creatorLinks: [{ kind: 'merchandise', title: 'Unsafe', url: 'https://creator:secret@shop.example/drop' }],
    }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const duplicate = { kind: 'social', title: 'Follow', url: 'https://social.example/creator' };
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({ creatorLinks: [duplicate, duplicate] }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.party.upsert).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated draft creation', async () => {
    await expect(createPublicCaller().events.drafts.create(draft())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('denies Apple Discovery to a Green host without trusting a client tier', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published' }));
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: false });
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-1', name: 'The Loft', lat: 33.749, lng: -84.388 });

    await expect(createAuthenticatedCaller(HOST).events.discovery.request({
      partyId: 'party-1', idempotencyKey: 'apple-discovery-12345678', venueId: 'venue-1',
      card: { title: 'First Listen', subtitle: 'One moment. Your people.' },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.partyAppleDiscoveryJob.upsert).not.toHaveBeenCalled();
  });

  it('queues an idempotent Platinum Discovery request from verified venue coordinates', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published', coverImageUrl: 'https://res.cloudinary.com/bytspot/cover.jpg' }));
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: true });
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-1', name: 'The Loft', lat: 33.749, lng: -84.388 });
    (db.partyAppleDiscoveryJob.upsert as any).mockImplementationOnce(({ create }: any) => ({ id: 'apple-job-1', ...create, attemptCount: 0 }));

    const result = await createAuthenticatedCaller(HOST).events.discovery.request({
      partyId: 'party-1', idempotencyKey: 'apple-discovery-12345678', venueId: 'venue-1',
      card: { title: 'First Listen', subtitle: 'One moment. Your people.' },
    });

    expect(result).toMatchObject({ id: 'apple-job-1', status: 'configuration_required', hostTier: 'platinum', failureCode: 'apple_discovery_worker_unconfigured', fallback: { mode: 'standard-party-pass', shareUrl: 'https://bytspot.app/party/party-1' } });
    expect(db.partyAppleDiscoveryJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { partyId: 'party-1' },
      create: expect.objectContaining({
        requestedByUserId: HOST,
        hostTier: 'platinum',
        request: expect.objectContaining({
          invocationUrl: 'https://bytspot.app/party/party-1',
          venue: { id: 'venue-1', name: 'The Loft', latitude: 33.749, longitude: -84.388 },
        }),
      }),
    }));
  });

  it('refuses Apple Discovery for a hidden Party location even for a Platinum host', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', templateId: 'pop-up', accessMode: 'private-approval',
      templateConfig: { kind: 'pop-up', locationDisclosure: 'after-approval' },
    }));
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: true });
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-1', name: 'The Loft', lat: 33.749, lng: -84.388 });

    await expect(createAuthenticatedCaller(HOST).events.discovery.request({
      partyId: 'party-1', idempotencyKey: 'apple-discovery-12345678', venueId: 'venue-1',
      card: { title: 'First Listen', subtitle: 'One moment. Your people.' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.partyAppleDiscoveryJob.upsert).not.toHaveBeenCalled();
  });

  it('refuses Apple Discovery for an approval-only Private Party even for a Platinum host', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', templateId: 'private-party', accessMode: 'private-approval',
      templateConfig: { kind: 'private-party', guestPolicy: 'named-guests' },
    }));
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: true });
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-1', name: 'The Loft', lat: 33.749, lng: -84.388 });

    await expect(createAuthenticatedCaller(HOST).events.discovery.request({
      partyId: 'party-1', idempotencyKey: 'apple-discovery-12345678', venueId: 'venue-1',
      card: { title: 'First Listen', subtitle: 'One moment. Your people.' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.partyAppleDiscoveryJob.upsert).not.toHaveBeenCalled();
  });

  it('does not requeue a legacy Discovery job after a Party location becomes private', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', templateId: 'private-party', accessMode: 'private-approval',
      templateConfig: { kind: 'private-party', guestPolicy: 'named-guests' },
    }));

    await expect(createAuthenticatedCaller(HOST).events.discovery.retry({
      partyId: 'party-1', idempotencyKey: 'apple-discovery-12345678',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.partyAppleDiscoveryJob.findUnique).not.toHaveBeenCalled();
    expect(db.partyAppleDiscoveryJob.update).not.toHaveBeenCalled();
  });

  it('binds an immutable verified Venue as the host-only Party arrival destination', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published' }));
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-1', name: 'The Loft', address: '100 Peachtree St', lat: 33.749, lng: -84.388 });
    (db.hardwarePatch.findFirst as any).mockResolvedValueOnce({ id: 'venue-patch-1' });
    (db.partyArrivalDestination.upsert as any).mockImplementationOnce(({ create }: any) => ({ id: 'arrival-1', ...create, boundAt: new Date('2026-08-08T12:00:00Z') }));

    await expect(createAuthenticatedCaller(HOST).events.arrival.bindDestination({ partyId: 'party-1', venueId: 'venue-1' }))
      .resolves.toMatchObject({ partyId: 'party-1', venueId: 'venue-1', boundAt: '2026-08-08T12:00:00.000Z' });
    expect(db.partyArrivalDestination.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { partyId: 'party-1' },
      create: expect.objectContaining({ partyId: 'party-1', venueId: 'venue-1', boundByUserId: HOST }),
      update: {},
    }));
    expect(db.hardwarePatch.findFirst).toHaveBeenCalledWith({
      where: { status: 'bound', bindingType: 'venue', bindingId: 'venue-1' }, select: { id: true },
    });
  });

  it('rejects an exact-name, valid-coordinate Venue without a verified hardware patch', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published' }));
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-1', name: 'The Loft', address: '100 Peachtree St', lat: 33.749, lng: -84.388 });
    (db.hardwarePatch.findFirst as any).mockResolvedValueOnce(null);

    await expect(createAuthenticatedCaller(HOST).events.arrival.bindDestination({ partyId: 'party-1', venueId: 'venue-1' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.partyArrivalDestination.upsert).not.toHaveBeenCalled();
  });

  it('does not bind an arrival destination before the Party is published', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'draft' }));
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-1', name: 'The Loft', address: '100 Peachtree St', lat: 33.749, lng: -84.388 });

    await expect(createAuthenticatedCaller(HOST).events.arrival.bindDestination({ partyId: 'party-1', venueId: 'venue-1' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.hardwarePatch.findFirst).not.toHaveBeenCalled();
    expect(db.partyArrivalDestination.upsert).not.toHaveBeenCalled();
  });

  it('rejects a mismatched or changed Party arrival destination without writing it', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published' }));
    (db.venue.findUnique as any).mockResolvedValueOnce({ id: 'venue-2', name: 'Other Loft', address: '200 Peachtree St', lat: 33.75, lng: -84.39 });

    await expect(createAuthenticatedCaller(HOST).events.arrival.bindDestination({ partyId: 'party-1', venueId: 'venue-2' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.partyArrivalDestination.upsert).not.toHaveBeenCalled();
  });

  it('returns only the verified destination and device-managed traffic label to an access-granted guest', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', arrivalDestination: {
        venue: { id: 'venue-1', name: 'The Loft', address: '100 Peachtree St', lat: 33.749, lng: -84.388 },
      },
      participations: [{ status: 'approved' }],
    }));

    const result = await createAuthenticatedCaller('guest-1').events.arrival.context({ partyId: 'party-1' });

    expect(result).toMatchObject({
      partyId: 'party-1',
      destination: { venueId: 'venue-1', name: 'The Loft', address: '100 Peachtree St', latitude: 33.749, longitude: -84.388 },
      map: { provider: 'apple-maps' },
      traffic: { source: 'device', status: 'unavailable' },
      ride: { status: 'unconfigured' },
    });
    expect(result.map.directionsUrl).toContain('daddr=33.749%2C-84.388');
    expect(result).not.toHaveProperty('pickup');
    expect(result).not.toHaveProperty('origin');
  });

  it('does not reveal an arrival destination to a pending private-approval guest', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', accessMode: 'private-approval',
      templateId: 'private-party', templateConfig: { kind: 'private-party', guestPolicy: 'named-guests' },
      arrivalDestination: { venue: { id: 'venue-1', name: 'The Loft', address: '100 Peachtree St', lat: 33.749, lng: -84.388 } },
      participations: [{ status: 'pending' }],
    }));

    await expect(createAuthenticatedCaller('guest-1').events.arrival.context({ partyId: 'party-1' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a ticket tier that bypasses the party membership gate', async () => {
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({
      accessMode: 'paid-ticket', requiredMembershipTier: 'black',
      ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
    }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.party.upsert).not.toHaveBeenCalled();
  });

  it('requires an explicit cash amount only for cash-at-door Parties', async () => {
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({ accessMode: 'cash-at-door' }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({ accessMode: 'free-rsvp', cashDoorPriceCents: 2500 }) as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    (db.party.upsert as any).mockImplementationOnce(({ create }: any) => party({ ...create, draftFingerprint: create.draftFingerprint }));
    await expect(createAuthenticatedCaller(HOST).events.drafts.create(draft({ accessMode: 'cash-at-door', cashDoorPriceCents: 2500 }) as any)).resolves.toEqual({ id: 'party-1', status: 'draft' });
    expect(db.party.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ create: expect.objectContaining({ accessMode: 'cash-at-door', cashDoorPriceCents: 2500, ticketTiers: [] }) }));
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
    expect(db.groupEvent.upsert).not.toHaveBeenCalled();
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
    expect(db.groupEvent.upsert).not.toHaveBeenCalled();
  });

  it('returns the exact published Host Studio Party as a public invite', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', passCode: 'PARTY826', host: { name: 'Avery Parker' },
      coverImageUrl: 'https://res.cloudinary.com/bytspot/image/upload/cover.jpg',
      photoUrls: ['https://res.cloudinary.com/bytspot/image/upload/album-0.jpg'],
    }));
    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({
      id: 'party-1', source: 'host-studio-party', title: 'First Listen', inviteNote: 'One moment. Your people.',
      tier: 'green', participantCount: 0, capacity: 80, accessMode: 'free-rsvp',
      ticketTiers: [],
      creatorLinks: [{ kind: 'music', title: 'Listen now', url: 'https://music.example/first-listen' }],
      templateId: 'listening-party', templateConfig: { kind: 'listening-party', format: 'listening-session' },
      hostName: 'Avery Parker', locationLabel: 'The Loft', activityHighlights: ['Doors open'],
      audienceCircle: 'Selected Circles', privacyStatus: 'privateInvite', requiresApproval: false,
      heroImageURL: 'https://res.cloudinary.com/bytspot/image/upload/cover.jpg',
      photoURLs: ['https://res.cloudinary.com/bytspot/image/upload/album-0.jpg'],
    });
  });

  it('fails closed by omitting malformed stored creator links from a public Party Pass', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', host: { name: 'Avery Parker' }, creatorLinks: [{ kind: 'music', title: 'Unsafe', url: 'http://music.example/release' }],
    }));

    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result.creatorLinks).toEqual([]);
  });

  it('projects only validated paid ticket tiers for a Party Pass', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', host: { name: 'Avery Parker' }, accessMode: 'paid-ticket',
      ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
    }));

    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result.ticketTiers).toEqual([{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }]);
  });

  it('projects a cash-door amount without exposing Stripe ticket tiers', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', host: { name: 'Avery Parker' }, accessMode: 'cash-at-door', cashDoorPriceCents: 2500,
      ticketTiers: [{ name: 'Must not publish', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
    }));

    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({ accessMode: 'cash-at-door', cashDoorPriceCents: 2500, ticketTiers: [] });
  });

  it('fails closed when a stored cash-at-door Party has no valid cash amount', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', host: { name: 'Avery Parker' }, accessMode: 'cash-at-door', cashDoorPriceCents: null,
    }));

    await expect(createPublicCaller().events.invite({ partyId: 'party-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('redacts a Pop-Up location from every public Party Pass projection', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      templateId: 'pop-up', templateConfig: { kind: 'pop-up', locationDisclosure: 'after-approval' }, status: 'published', host: { name: 'Avery Parker' },
    }));
    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({ locationLabel: 'Location shared after approval', locationDisclosure: 'after-approval' });
  });

  it('redacts an approval-only Private Party location from every public Party Pass projection', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      templateId: 'private-party', accessMode: 'private-approval',
      templateConfig: { kind: 'private-party', guestPolicy: 'named-guests' },
      status: 'published', host: { name: 'Avery Parker' }, venueName: 'Secret loft',
    }));
    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({ locationLabel: 'Location shared after approval', locationDisclosure: 'after-approval' });
    expect(result.locationLabel).not.toContain('Secret loft');
  });

  it('redacts a non-Pop-Up Party location whenever host approval is required', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      accessMode: 'private-approval', status: 'published', host: { name: 'Avery Parker' }, venueName: 'Secret listening room',
    }));
    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({ locationLabel: 'Location shared after approval', locationDisclosure: 'after-approval', requiresApproval: true });
    expect(result.locationLabel).not.toContain('Secret listening room');
  });

  it('fails closed for a Pop-Up with malformed stored configuration', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      templateId: 'pop-up', templateConfig: { kind: 'standard' }, status: 'published', host: { name: 'Avery Parker' }, venueName: 'Secret rooftop',
    }));

    const result = await createPublicCaller().events.invite({ partyId: 'party-1' });

    expect(result).toMatchObject({ locationLabel: 'Location shared after approval', locationDisclosure: 'after-approval' });
    expect(result.locationLabel).not.toContain('Secret rooftop');
    expect(result.templateConfig).toBeNull();
  });

  it('requires authentication before exposing an RSVP, cash reservation, or ticket action', async () => {
    (db.partyTouchpoint.findUnique as any).mockResolvedValueOnce({
      partyId: 'party-1', reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'active',
      lifecyclePolicy: { version: 1, before: { action: 'ticket' }, atDoor: { action: 'unavailable' }, during: { action: 'unavailable' }, after: { action: 'unavailable' } },
      party: party({ status: 'published', startsAt: new Date('2099-08-10T20:00:00Z') }),
    });

    const result = await createPublicCaller().events.pass.resolve({ touchpointRef: 'p1_0123456789abcdefghijklmnop' });

    expect(result).toEqual(expect.objectContaining({ partyId: 'party-1', lifecycle: 'before', action: 'authenticate', guest: { status: 'anonymous', canStartPrimaryAction: false, accessGranted: false } }));
  });

  it('lets an anonymous viewer open an open-entry Party without a reservation or payment', async () => {
    (db.partyTouchpoint.findUnique as any).mockResolvedValueOnce({
      partyId: 'party-1', reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'active',
      lifecyclePolicy: { version: 1, before: { action: 'view-pass' }, atDoor: { action: 'view-pass' }, during: { action: 'view-pass' }, after: { action: 'view-pass' } },
      party: party({ status: 'published', accessMode: 'open-entry', startsAt: new Date('2099-08-10T20:00:00Z') }),
    });

    const result = await createPublicCaller().events.pass.resolve({ touchpointRef: 'p1_0123456789abcdefghijklmnop' });

    expect(result).toEqual(expect.objectContaining({ action: 'view-pass', guest: { status: 'anonymous', canStartPrimaryAction: false, accessGranted: true } }));
  });

  it('creates Party-native RSVP state without reading or writing legacy guests', async () => {
    const published = party({ status: 'published', startsAt: new Date('2099-08-10T20:00:00Z'), touchpoints: [{ reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'active' }] });
    (db.party.findUnique as any).mockResolvedValueOnce(published);
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: false });
    (db.partyParticipation.findUnique as any).mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'rsvp', checkedInAt: null });
    (db.partyParticipation.count as any).mockResolvedValueOnce(0);

    const result = await createAuthenticatedCaller('guest-1').events.rsvp.create({ partyId: 'party-1', idempotencyKey: 'rsvp-12345678' });

    expect(result).toMatchObject({ partyId: 'party-1', status: 'rsvp', action: 'view-pass', accessGranted: true });
    expect(db.partyParticipation.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ partyId: 'party-1', userId: 'guest-1', status: 'rsvp' }) }));
    expect(db.groupEventGuest.upsert).not.toHaveBeenCalled();
  });

  it('reserves a cash-at-door Party without starting Stripe checkout', async () => {
    const published = party({ status: 'published', accessMode: 'cash-at-door', cashDoorPriceCents: 2500, startsAt: new Date('2099-08-10T20:00:00Z'), touchpoints: [{ reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'active' }] });
    (db.party.findUnique as any).mockResolvedValueOnce(published);
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: false });
    (db.partyParticipation.findUnique as any).mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'rsvp', checkedInAt: null });
    (db.partyParticipation.count as any).mockResolvedValueOnce(0);

    const result = await createAuthenticatedCaller('guest-1').events.rsvp.create({ partyId: 'party-1', idempotencyKey: 'rsvp-12345678' });

    expect(result).toMatchObject({ partyId: 'party-1', status: 'rsvp', action: 'view-pass', accessGranted: true });
    expect(db.partyParticipation.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: 'rsvp' }) }));
    expect(db.partyTicketOrder.create).not.toHaveBeenCalled();
  });

  it('serializes cash admissions before checking capacity and rejects a full Party without writing', async () => {
    const published = party({ status: 'published', capacity: 1, accessMode: 'cash-at-door', cashDoorPriceCents: 2500, startsAt: new Date('2099-08-10T20:00:00Z') });
    (db.party.findUnique as any).mockResolvedValueOnce(published);
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: false });
    (db.partyParticipation.findUnique as any).mockResolvedValueOnce(null);
    (db.partyParticipation.count as any).mockResolvedValueOnce(1);

    await expect(createAuthenticatedCaller('guest-2').events.rsvp.create({ partyId: 'party-1', idempotencyKey: 'cash-full-12345678' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect((db.$queryRaw as any).mock.invocationCallOrder[0]).toBeLessThan((db.partyParticipation.findUnique as any).mock.invocationCallOrder[0]);
    expect((db.$queryRaw as any).mock.invocationCallOrder[0]).toBeLessThan((db.partyParticipation.count as any).mock.invocationCallOrder[0]);
    expect(db.partyParticipation.upsert).not.toHaveBeenCalled();
  });

  it('rejects a cash reservation when the persisted cash amount is invalid', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({
      status: 'published', accessMode: 'cash-at-door', cashDoorPriceCents: 0, startsAt: new Date('2099-08-10T20:00:00Z'),
    }));

    await expect(createAuthenticatedCaller('guest-1').events.rsvp.create({ partyId: 'party-1', idempotencyKey: 'rsvp-12345678' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.partyParticipation.upsert).not.toHaveBeenCalled();
  });

  it('returns an unavailable pass action for a cash Party with a malformed amount', async () => {
    (db.partyTouchpoint.findUnique as any).mockResolvedValueOnce({
      partyId: 'party-1', reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'active', lifecyclePolicy: {},
      party: party({ status: 'published', accessMode: 'cash-at-door', cashDoorPriceCents: null, startsAt: new Date('2099-08-10T20:00:00Z') }),
    });

    const result = await createPublicCaller().events.pass.resolve({ touchpointRef: 'p1_0123456789abcdefghijklmnop' });

    expect(result).toEqual(expect.objectContaining({ action: 'unavailable', guest: expect.objectContaining({ accessGranted: false }) }));
  });

  it('rejects direct ticket checkout unless the authoritative action is ticket', async () => {
    const originalStripeKey = config.stripeSecretKey;
    config.stripeSecretKey = 'sk_test_party_action_policy';
    try {
      (db.party.findUnique as any).mockResolvedValue(party({ status: 'published', accessMode: 'paid-ticket', startsAt: new Date('2099-08-10T20:00:00Z') }));
      (db.user.findUnique as any).mockResolvedValue({ isPremium: false });
      ((db as any).membershipEntitlement.findFirst as any).mockResolvedValue(null);
      (db.partyParticipation.findUnique as any)
        .mockResolvedValueOnce({ status: 'pending' })
        .mockResolvedValueOnce({ status: 'declined' })
        .mockResolvedValueOnce({ status: 'cancelled' });

      for (const status of ['pending', 'declined', 'cancelled']) {
        await expect(createAuthenticatedCaller('guest-1').events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey: `ticket-${status}-12345678` })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(db.partyTicketOrder.create).not.toHaveBeenCalled();
      expect(db.checkoutAttempt.create).not.toHaveBeenCalled();
    } finally {
      config.stripeSecretKey = originalStripeKey;
    }
  });

  it('fails closed for a Platinum Party when the authenticated member lacks the server entitlement', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party({ status: 'published', requiredMembershipTier: 'platinum', startsAt: new Date('2099-08-10T20:00:00Z') }));
    (db.user.findUnique as any).mockResolvedValueOnce({ isPremium: false });

    await expect(createAuthenticatedCaller('guest-1').events.rsvp.create({ partyId: 'party-1', idempotencyKey: 'rsvp-12345678' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.partyParticipation.upsert).not.toHaveBeenCalled();
  });

  it('fails closed for inactive touchpoints', async () => {
    (db.partyTouchpoint.findUnique as any).mockResolvedValueOnce({ partyId: 'party-1', reference: 'p1_0123456789abcdefghijklmnop', kind: 'digital', status: 'inactive', lifecyclePolicy: {}, party: party({ status: 'published' }) });
    await expect(createPublicCaller().events.pass.resolve({ touchpointRef: 'p1_0123456789abcdefghijklmnop' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fulfills the immutable checkout attempt identified by the original Stripe session exactly once', async () => {
    (db.checkoutAttempt.updateMany as any).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    (db.checkoutAttempt.findUnique as any).mockResolvedValueOnce({ partyTicketOrderId: 'order-1' });
    (db.partyTicketOrder.findUnique as any).mockResolvedValueOnce({ id: 'order-1', partyId: 'party-1', userId: 'guest-1' });
    (db.partyTicketOrder.updateMany as any).mockResolvedValueOnce({ count: 1 });
    (db.partyParticipation.findUnique as any).mockResolvedValueOnce(null);
    const caller = createStripeWebhookCaller();
    const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_test_original', payment_status: 'paid', payment_intent: 'pi_1', metadata: { flow: 'party.ticket', checkoutAttemptId: 'attempt-1' } } } };

    await expect(caller.events.tickets.webhook(event)).resolves.toEqual({ reconciled: 'fulfilled' });
    await expect(caller.events.tickets.webhook(event)).resolves.toEqual({ reconciled: 'fulfilled' });
    expect(db.checkoutAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeSessionId: 'cs_test_original', reconciliationState: 'pending' }, data: expect.objectContaining({ reconciliationState: 'fulfilled', stripePaymentIntentId: 'pi_1' }) }));
    expect(db.partyParticipation.create).toHaveBeenCalledTimes(1);
  });

  it('releases a hold only when Stripe reports that the exact unpaid session expired', async () => {
    (db.checkoutAttempt.updateMany as any).mockResolvedValueOnce({ count: 1 });
    const caller = createStripeWebhookCaller();
    const result = await caller.events.tickets.webhook({ type: 'checkout.session.expired', data: { object: { id: 'cs_test_expired', status: 'expired', payment_status: 'unpaid', metadata: { flow: 'party.ticket' } } } });

    expect(result).toEqual({ reconciled: 'expired' });
    expect(db.checkoutAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeSessionId: 'cs_test_expired', reconciliationState: 'pending' }, data: expect.objectContaining({ reconciliationState: 'expired' }) }));
    expect(db.partyTicketOrder.updateMany).not.toHaveBeenCalled();
  });

  it('does not expose drafts through the public invite route', async () => {
    (db.party.findUnique as any).mockResolvedValueOnce(party());
    await expect(createPublicCaller().events.invite({ partyId: 'party-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});