import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';
import { config } from '../config';

const idempotencyKey = '00000000-0000-4000-8000-000000000001';
const draftInput = {
  idempotencyKey,
  templateId: 'listening-party' as const,
  title: 'First Listen',
  tagline: 'One moment. Your people.',
  startsAt: '2026-08-10T20:00:00Z',
  venueName: 'Sample Venue',
  locationDisclosure: 'public' as const,
  capacity: 80,
  accessMode: 'free-rsvp' as const,
  requiredMembershipTier: 'green' as const,
  hostDestinations: { musicUrl: 'https://music.example.com/host', primarySocial: { platform: 'Instagram', url: 'https://instagram.com/host' } },
  audienceCircleIds: ['circle-1'],
  itinerary: [{ title: 'Doors open', offsetMinutes: 0 }],
  ticketTiers: [],
  cohosts: [],
  templateConfig: { kind: 'listening-party' as const, format: 'listening-session' },
  source: 'host-studio' as const,
};
const partyDraft = { id: 'party-1', hostUserId: 'test-user-id', idempotencyKey, status: 'draft' };
// Share-link expiry fixture: an upcoming party whose link is still alive
// under the default policy (dies when the party ends).
const linkAlive = { startsAt: new Date(Date.now() + 60 * 60 * 1000), endsAt: new Date(Date.now() + 4 * 60 * 60 * 1000), shareLinkExpiresAt: null };
const createCaller = createCallerFactory(appRouter);
const authenticatedContext: Context = { user: { userId: 'test-user-id', email: 'test@bytspot.com' }, clientRateLimitKey: 'test-party-client' };
const party = db.party as any;
const partyMedia = db.partyMedia as any;
const partyGuest = db.partyGuest as any;
const partyCheckout = db.partyCheckout as any;
const venue = db.venue as any;
const user = db.user as any;
const prisma = db as any;

function caller() {
  return createCaller(authenticatedContext);
}

beforeEach(() => {
  (db.hostProfile as any).findUnique = async () => null;
  (db.hostProfile as any).upsert = async () => ({});
  party.findUnique = async () => null;
  party.findFirst = async () => null;
  party.create = async () => ({ id: 'party-1' });
  party.updateMany = async () => ({ count: 1 });
  partyMedia.deleteMany = async () => ({ count: 0 });
  partyMedia.upsert = async () => ({ id: 'media-1' });
  partyMedia.findUnique = async () => null;
  partyGuest.count = async () => 0;
  partyGuest.findUnique = async () => null;
  partyGuest.findFirst = async () => null;
  partyGuest.upsert = async ({ create }: any) => ({ id: 'guest-1', ...create });
  partyGuest.create = async ({ data }: any) => ({ id: 'guest-1', ...data });
  partyGuest.update = async ({ data }: any) => ({ id: 'guest-1', ...data });
  partyCheckout.findUnique = async () => null;
  partyCheckout.findFirst = async () => null;
  partyCheckout.count = async () => 0;
  partyCheckout.create = async ({ data }: any) => ({ id: 'checkout-1', ...data });
  partyCheckout.update = async () => ({ id: 'checkout-1' });
  partyCheckout.updateMany = async () => ({ count: 0 });
  venue.findUnique = async () => null;
  user.findUnique = async () => ({ membershipTier: 'green' });
  (config as any).stripeSecretKey = '';
  prisma.$transaction = async (callback: any) => callback({ party, partyMedia, partyGuest, partyCheckout });
});

test('Party draft creation requires authentication', async () => {
  const publicCaller = createCaller({ user: null });
  await assert.rejects(() => publicCaller.events.drafts.create(draftInput), { code: 'UNAUTHORIZED' });
});

test('Party draft creation persists the authenticated host and refreshes a retryable draft', async () => {
  let createData: any;
  party.create = async ({ data }: any) => {
    createData = data;
    return { id: 'party-1' };
  };
  assert.deepEqual(await caller().events.drafts.create(draftInput), { id: 'party-1' });
  assert.equal(createData.hostUserId, 'test-user-id');
  assert.equal(createData.idempotencyKey, idempotencyKey);
  assert.equal(createData.locationDisclosure, 'public');
  assert.deepEqual(createData.hostDestinations, { musicUrl: 'https://music.example.com/host', primarySocial: { platform: 'Instagram', url: 'https://instagram.com/host' } });

  party.findUnique = async () => partyDraft;
  party.create = async () => { throw new Error('must not create duplicate draft'); };
  let updated: any;
  party.updateMany = async ({ data }: any) => {
    updated = data;
    return { count: 1 };
  };
  assert.deepEqual(await caller().events.drafts.create({ ...draftInput, title: 'Edited First Listen' }), { id: 'party-1' });
  assert.equal(updated.title, 'Edited First Listen');
});

test('Draft retries do not update content after publishing wins the race', async () => {
  const publishedParty = { ...partyDraft, status: 'published', passCode: 'BYT-EXISTING' };
  party.findUnique = async () => partyDraft;
  party.updateMany = async () => ({ count: 0 });
  party.findFirst = async () => publishedParty;

  assert.deepEqual(await caller().events.drafts.create({ ...draftInput, title: 'Too Late To Change' }), { id: 'party-1' });
});

test('Party deletion is host-only, allows drafts, and refuses committed guests', async () => {
  party.findFirst = async () => null;
  await assert.rejects(() => caller().events.drafts.delete({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  // Draft with no committed guests deletes atomically.
  let deleteWhere: any;
  party.findFirst = async () => partyDraft;
  party.deleteMany = async ({ where }: any) => {
    deleteWhere = where;
    return { count: 1 };
  };
  assert.deepEqual(await caller().events.drafts.delete({ partyId: 'party-1' }), { success: true });
  assert.equal(deleteWhere.hostUserId, 'test-user-id');
  assert.deepEqual(deleteWhere.guests, { none: { OR: [{ status: 'ticketed' }, { checkedInAt: { not: null } }] } });
  assert.deepEqual(deleteWhere.checkouts.none.OR[0], { status: 'completed' });
  assert.deepEqual(deleteWhere.checkouts.none.OR[1].status, { in: ['creating', 'pending'] });

  // Published party with a ticketed guest is refused before any delete.
  party.findFirst = async () => ({ ...partyDraft, status: 'published' });
  partyGuest.findFirst = async () => ({ id: 'guest-1' });
  await assert.rejects(() => caller().events.drafts.delete({ partyId: 'party-1' }), { code: 'CONFLICT' });

  // Published party with an in-flight Stripe checkout (unpaid, unexpired
  // reservation) is refused so the webhook can still reconcile/refund.
  partyGuest.findFirst = async () => null;
  partyCheckout.findFirst = async () => ({ id: 'checkout-1' });
  await assert.rejects(() => caller().events.drafts.delete({ partyId: 'party-1' }), { code: 'CONFLICT' });

  // Race guard: guest commits or checkout opens between the check and the delete.
  partyCheckout.findFirst = async () => null;
  party.deleteMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().events.drafts.delete({ partyId: 'party-1' }), { code: 'CONFLICT' });
});

test('Party draft creation accepts iOS standard templates and Black tier', async () => {
  await assert.doesNotReject(() => caller().events.drafts.create({
    ...draftInput, templateId: 'comedy-night', requiredMembershipTier: 'black', templateConfig: { kind: 'standard' },
  }));
  await assert.doesNotReject(() => caller().events.drafts.create({
    ...draftInput, templateId: 'premiere', templateConfig: { kind: 'standard' },
  }));
});

test('Party draft creation accepts withheld locations and rejects insecure official destinations', async () => {
  await assert.doesNotReject(() => caller().events.drafts.create({
    ...draftInput, locationDisclosure: 'withheld', templateId: 'comedy-night', templateConfig: { kind: 'standard' },
  }));
  await assert.rejects(() => caller().events.drafts.create({
    ...draftInput, hostDestinations: { websiteUrl: 'http://not-secure.example.com' },
  }));
  await assert.rejects(() => caller().events.drafts.create({
    ...draftInput, locationDisclosure: 'after-approval', accessMode: 'free-rsvp',
  }));
});

test('Party mutations reject host-declined guests even when invoked directly', async () => {
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'paid-ticket', ...linkAlive, ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }] });
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'declined', accessGranted: false });
  await assert.rejects(() => caller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey }), { code: 'FORBIDDEN' });

  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', capacity: 40, ...linkAlive });
  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'FORBIDDEN' });
});

test('Free RSVP capacity is enforced inside a serializable transaction', async () => {
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 1, ...linkAlive });
  partyGuest.count = async () => 1;
  let transactionOptions: any;
  prisma.$transaction = async (callback: any, options: any) => {
    transactionOptions = options;
    return callback({ partyGuest });
  };

  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'CONFLICT' });
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
});

test('Free RSVP maps serialization conflicts to retryable capacity conflicts', async () => {
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 2, ...linkAlive });
  prisma.$transaction = async () => { throw { code: 'P2034' }; };

  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'CONFLICT' });
});

test('Paid checkout retries return the persisted pending reservation', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40, title: 'First Listen', tagline: 'One moment.', ...linkAlive,
    ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
  });
  (config as any).stripeSecretKey = 'test-only-key';
  partyCheckout.findUnique = async () => ({
    id: 'checkout-1', ticketTierName: 'First Drop', amountCents: 2500, currency: 'usd', status: 'pending', checkoutUrl: 'https://checkout.stripe.test/session',
  });

  assert.deepEqual(await caller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey }), {
    url: 'https://checkout.stripe.test/session',
  });
});

test('Paid checkout rejects an idempotent retry that changes tier and a second active reservation', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40, title: 'First Listen', tagline: 'One moment.', ...linkAlive,
    ticketTiers: [
      { name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' },
      { name: 'Late Drop', priceCents: 3000, quantity: 40, requiredMembershipTier: 'green' },
    ],
  });
  (config as any).stripeSecretKey = 'test-only-key';
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', ticketTierName: 'First Drop', amountCents: 2500, currency: 'usd', status: 'creating' });
  await assert.rejects(() => caller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'Late Drop', idempotencyKey }), { code: 'CONFLICT' });

  partyCheckout.findUnique = async () => null;
  partyCheckout.findFirst = async () => ({ id: 'checkout-active' });
  await assert.rejects(() => caller().events.tickets.createCheckout({
    partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey: '00000000-0000-4000-8000-000000000002',
  }), { code: 'CONFLICT' });
});

test('Public Party invitations redact protected venues and project only official destinations', async () => {
  party.findFirst = async () => ({
    id: 'party-1', title: 'Secret Set', tagline: 'See you there.', templateId: 'pop-up', requiredMembershipTier: 'black', endsAt: linkAlive.endsAt, shareLinkExpiresAt: null,
    startsAt: new Date('2026-08-10T20:00:00Z'), venueName: 'Never Return This Venue', locationDisclosure: 'withheld',
    accessMode: 'paid-ticket', capacity: 40, hostDestinations: { musicUrl: 'https://music.example.com/host', primarySocial: { platform: 'Instagram', url: 'https://instagram.com/host' } },
    itinerary: [{ title: 'Doors', offsetMinutes: 0 }], ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
    host: { name: 'Host' }, media: [],
  });
  const invite = await createCaller({ user: null }).events.invite({ partyId: 'party-1' });
  assert.equal(invite.locationDisclosure, 'withheld');
  assert.equal(invite.locationLabel, null);
  assert.deepEqual(invite.host.destinations, { musicUrl: 'https://music.example.com/host', primarySocial: { platform: 'Instagram', url: 'https://instagram.com/host' } });
});

test('Only the host can bind a matching registered arrival venue to a published Party', async () => {
  party.findFirst = async ({ where }: any) => where.hostUserId
    ? { id: 'party-1', venueName: 'Sample Venue' }
    : null;
  venue.findUnique = async () => ({ id: 'venue-1', name: '  sample   venue ', address: '1 Example Way' });
  let update: any;
  party.updateMany = async (input: any) => { update = input; return { count: 1 }; };

  const result = await caller().events.arrival.bindDestination({ partyId: 'party-1', venueId: 'venue-1' });
  assert.deepEqual(result, { partyId: 'party-1', venue: { id: 'venue-1', name: '  sample   venue ', address: '1 Example Way' } });
  assert.deepEqual(update.where, { id: 'party-1', hostUserId: 'test-user-id', status: 'published' });
  assert.deepEqual(update.data, { arrivalVenueId: 'venue-1' });
});

test('Party arrival guidance requires an access-granted guest and a bound venue', async () => {
  party.findFirst = async () => ({
    id: 'party-1', requiredMembershipTier: 'green', arrivalVenue: { id: 'venue-1', name: 'Sample Venue', address: '1 Example Way', lat: 33.749, lng: -84.388 },
  });
  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: false });
  await assert.rejects(() => caller().events.arrival.context({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  const context = await caller().events.arrival.context({ partyId: 'party-1' });
  assert.equal(context.destination.venueId, 'venue-1');
  assert.match(context.map.directionsUrl, /^https:\/\/maps\.apple\.com\//);
});

test('Party handoff derives its destination from the bound venue and enforces premium membership', async () => {
  party.findFirst = async () => ({
    id: 'party-1', requiredMembershipTier: 'green', arrivalVenue: { id: 'venue-1', name: 'Sample Venue', address: '1 Example Way', lat: 33.749, lng: -84.388 },
  });
  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  user.findUnique = async () => ({ membershipTier: 'green' });
  await assert.rejects(() => caller().events.arrival.handoff({ partyId: 'party-1', provider: 'uber' }), { code: 'FORBIDDEN' });

  user.findUnique = async () => ({ membershipTier: 'black' });
  const handoff = await caller().events.arrival.handoff({ partyId: 'party-1', provider: 'uber' });
  const url = new URL(handoff.handoffUrl);
  assert.equal(url.host, 'm.uber.com');
  assert.equal(url.searchParams.get('dropoff[nickname]'), 'Sample Venue');
  assert.equal(url.searchParams.get('dropoff[formatted_address]'), '1 Example Way');
  assert.equal(handoff.trackingMode, 'handoff-only');
});

test('Party arrival context and handoff deny an access-granted guest downgraded below the Party tier', async () => {
  party.findFirst = async () => ({
    id: 'party-1', requiredMembershipTier: 'black', arrivalVenue: { id: 'venue-1', name: 'Sample Venue', address: '1 Example Way', lat: 33.749, lng: -84.388 },
  });
  partyGuest.findUnique = async () => ({ status: 'ticketed', accessGranted: true });
  user.findUnique = async () => ({ membershipTier: 'platinum' });

  await assert.rejects(() => caller().events.arrival.context({ partyId: 'party-1' }), { code: 'FORBIDDEN' });
  await assert.rejects(() => caller().events.arrival.handoff({ partyId: 'party-1', provider: 'uber' }), { code: 'FORBIDDEN' });
});

test('Party pass advertises premium handoff only when its host has bound an arrival venue', async () => {
  party.findFirst = async () => ({ id: 'party-1', accessMode: 'free-rsvp', requiredMembershipTier: 'green', arrivalVenueId: null });
  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  user.findUnique = async () => ({ membershipTier: 'platinum' });
  assert.equal((await caller().events.pass.resolve({ partyId: 'party-1' })).premiumMobilityEligible, false);

  party.findFirst = async () => ({ id: 'party-1', accessMode: 'free-rsvp', requiredMembershipTier: 'green', arrivalVenueId: 'venue-1' });
  assert.equal((await caller().events.pass.resolve({ partyId: 'party-1' })).premiumMobilityEligible, true);
});

test('Party pass and RSVP enforce the Party required membership tier', async () => {
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'black', capacity: 40, arrivalVenueId: null, ...linkAlive });
  user.findUnique = async () => ({ membershipTier: 'platinum' });
  assert.deepEqual(await caller().events.pass.resolve({ partyId: 'party-1' }), {
    partyId: 'party-1', action: 'unavailable', guest: { status: 'membership-required', accessGranted: false }, premiumMobilityEligible: false,
  });
  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'FORBIDDEN' });

  user.findUnique = async () => ({ membershipTier: 'black' });
  const pass = await caller().events.pass.resolve({ partyId: 'party-1' });
  assert.equal(pass.action, 'rsvp');
  assert.equal((await caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey })).accessGranted, true);
});

test('Paid ticket checkout enforces its required membership tier', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40, ...linkAlive,
    ticketTiers: [{ name: 'Black Table', priceCents: 2500, quantity: 40, requiredMembershipTier: 'black' }],
  });
  user.findUnique = async () => ({ membershipTier: 'platinum' });
  await assert.rejects(() => caller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'Black Table', idempotencyKey }), { code: 'FORBIDDEN' });
});

test('Party draft creation rejects mismatched template configuration', async () => {
  await assert.rejects(() => caller().events.drafts.create({
    ...draftInput,
    templateConfig: { kind: 'standard' as const },
  }));
});

test('Party media reset and upload require a host-owned draft', async () => {
  party.findFirst = async () => partyDraft;
  let resetPartyId = '';
  partyMedia.deleteMany = async ({ where }: any) => {
    resetPartyId = where.partyId;
    return { count: 1 };
  };
  assert.deepEqual(await caller().events.media.reset({ partyId: 'party-1' }), { status: 'ready' });
  assert.equal(resetPartyId, 'party-1');

  let uploaded: any;
  partyMedia.upsert = async (input: any) => {
    uploaded = input;
    return { id: 'media-1' };
  };
  assert.deepEqual(await caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:image/jpeg;base64,/9j/',
  }), { url: 'https://bytspot-api.onrender.com/media/parties/media-1' });
  assert.equal(uploaded.create.mimeType, 'image/jpeg');
  assert.equal(uploaded.create.byteSize, 3);
});

test('Party media upload rejects unsupported, mislabeled, and non-owner content', async () => {
  party.findFirst = async () => partyDraft;
  await assert.rejects(() => caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:text/plain;base64,QUJD',
  }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:image/jpeg;base64,QUJD',
  }), { code: 'BAD_REQUEST' });

  party.findFirst = async () => null;
  party.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().events.media.reset({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
});

test('Party publishing atomically produces one allowed share link and pass code', async () => {
  party.findFirst = async () => partyDraft;
  let updateWhere: any;
  party.updateMany = async ({ where }: any) => {
    updateWhere = where;
    return { count: 1 };
  };
  const result = await caller().events.publish({ partyId: 'party-1', idempotencyKey });
  assert.equal(result.id, 'party-1');
  assert.equal(result.shareUrl, 'https://bytspot.app/party/party-1');
  assert.match(result.passCode, /^BYT-[A-F0-9]{10}$/);
  assert.deepEqual(updateWhere, { id: 'party-1', hostUserId: 'test-user-id', status: 'draft' });
});

test('A concurrent publish returns the already-issued Party Pass', async () => {
  let calls = 0;
  party.findFirst = async () => {
    calls += 1;
    return calls === 1 ? partyDraft : { ...partyDraft, status: 'published', passCode: 'BYT-EXISTING' };
  };
  party.updateMany = async () => ({ count: 0 });
  assert.deepEqual(await caller().events.publish({ partyId: 'party-1', idempotencyKey }), {
    id: 'party-1', shareUrl: 'https://bytspot.app/party/party-1', passCode: 'BYT-EXISTING',
  });
});

test('A complete iOS retry returns a published Party Pass without changing media', async () => {
  const publishedParty = { ...partyDraft, status: 'published', passCode: 'BYT-EXISTING' };
  party.findUnique = async () => publishedParty;
  party.findFirst = async () => publishedParty;
  party.updateMany = async () => ({ count: 0 });
  partyMedia.findUnique = async () => ({ id: 'media-1' });
  let deleteCalls = 0;
  let upsertCalls = 0;
  partyMedia.deleteMany = async () => {
    deleteCalls += 1;
    return { count: 0 };
  };
  partyMedia.upsert = async () => {
    upsertCalls += 1;
    return { id: 'media-1' };
  };

  assert.deepEqual(await caller().events.drafts.create(draftInput), { id: 'party-1' });
  assert.deepEqual(await caller().events.media.reset({ partyId: 'party-1' }), { status: 'published' });
  assert.deepEqual(await caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:image/jpeg;base64,/9j/',
  }), { url: 'https://bytspot-api.onrender.com/media/parties/media-1' });
  assert.deepEqual(await caller().events.publish({ partyId: 'party-1', idempotencyKey }), {
    id: 'party-1', shareUrl: 'https://bytspot.app/party/party-1', passCode: 'BYT-EXISTING',
  });
  assert.equal(deleteCalls, 0);
  assert.equal(upsertCalls, 0);
});

test('Party publishing retries a pass-code uniqueness collision', async () => {
  party.findFirst = async () => partyDraft;
  let attempts = 0;
  party.updateMany = async () => {
    attempts += 1;
    if (attempts === 1) throw { code: 'P2002' };
    return { count: 1 };
  };
  const result = await caller().events.publish({ partyId: 'party-1', idempotencyKey });
  assert.match(result.passCode, /^BYT-[A-F0-9]{10}$/);
  assert.equal(attempts, 2);
});
test('Share link dies when the party ends: expired links 404 for new arrivals but not confirmed guests', async () => {
  const ended = { startsAt: new Date(Date.now() - 8 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 60 * 60 * 1000), shareLinkExpiresAt: null };
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 40, arrivalVenueId: null,
    title: 'Late Set', tagline: 'Done.', templateId: 'pop-up', venueName: 'Somewhere', locationDisclosure: 'public',
    itinerary: [], ticketTiers: [], hostDestinations: null, host: { name: 'Host' }, media: [], ...ended,
  });

  // New arrivals: invite, pass resolve, and RSVP are indistinguishable from a deleted party.
  partyGuest.findUnique = async () => null;
  await assert.rejects(() => createCaller({ user: null }).events.invite({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller().events.invite({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller().events.pass.resolve({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'NOT_FOUND' });

  // A confirmed guest keeps their pass — and every share-link procedure —
  // after expiry: pass resolve, invite landing, and RSVP re-calls.
  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  const pass = await caller().events.pass.resolve({ partyId: 'party-1' });
  assert.equal(pass.action, 'view-pass');
  assert.equal(pass.guest.accessGranted, true);
  assert.equal((await caller().events.invite({ partyId: 'party-1' })).id, 'party-1');
  assert.deepEqual(await caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { status: 'rsvp', accessGranted: true });
});

test('Expired paid-ticket share link still reports already-confirmed to a ticketed guest', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40,
    startsAt: new Date(Date.now() - 8 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 60 * 60 * 1000), shareLinkExpiresAt: null,
    ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
  });

  // Dedicated user: protected procedures rate-limit per user, and earlier
  // checkout tests consume test-user-id's party-ticket-checkout budget.
  const expiredCaller = () => createCaller({ user: { userId: 'expired-link-user', email: 'expired@bytspot.com' }, clientRateLimitKey: 'test-party-client' });
  user.findUnique = async () => ({ membershipTier: 'green' });

  // Without a confirmed pass the expired link is a 404, not a checkout error.
  partyGuest.findUnique = async () => null;
  await assert.rejects(() => expiredCaller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey }), { code: 'NOT_FOUND' });

  // A ticketed guest gets the normal already-confirmed conflict instead.
  partyGuest.findUnique = async () => ({ status: 'ticketed', accessGranted: true });
  await assert.rejects(() => expiredCaller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey }), { code: 'CONFLICT' });
});

test('Share link default expiry falls back to startsAt + 6h when the party has no end time', async () => {
  const base = {
    id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 40, arrivalVenueId: null,
    endsAt: null, shareLinkExpiresAt: null,
  };
  party.findFirst = async () => ({ ...base, startsAt: new Date(Date.now() - 7 * 60 * 60 * 1000) });
  await assert.rejects(() => caller().events.pass.resolve({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  party.findFirst = async () => ({ ...base, startsAt: new Date(Date.now() - 60 * 60 * 1000) });
  assert.equal((await caller().events.pass.resolve({ partyId: 'party-1' })).action, 'rsvp');
});

test('Host share-link expiry override wins and setShareLinkExpiry validates its input', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  // Override keeps the link alive past the party end.
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 40, arrivalVenueId: null,
    startsAt: new Date(Date.now() - 8 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 60 * 60 * 1000), shareLinkExpiresAt: future,
  });
  assert.equal((await caller().events.pass.resolve({ partyId: 'party-1' })).action, 'rsvp');

  // Host mutation: persists the override; rejects past timestamps.
  let updateArgs: any;
  party.updateMany = async (args: any) => { updateArgs = args; return { count: 1 }; };
  const result = await caller().events.control.setShareLinkExpiry({ partyId: 'party-1', expiresAt: future.toISOString() });
  assert.equal(result.shareLinkExpiresAt, future.toISOString());
  assert.equal(result.shareLinkExpiryIsDefault, false);
  assert.deepEqual(updateArgs.where, { id: 'party-1', hostUserId: 'test-user-id', status: 'published' });
  assert.deepEqual(updateArgs.data, { shareLinkExpiresAt: future });

  await assert.rejects(
    () => caller().events.control.setShareLinkExpiry({ partyId: 'party-1', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    { code: 'BAD_REQUEST' },
  );

  // Null restores the default policy (dies at party end).
  const restored = await caller().events.control.setShareLinkExpiry({ partyId: 'party-1', expiresAt: null });
  assert.equal(restored.shareLinkExpiryIsDefault, true);
});

test('Official Host identity lives on the host profile: handle + ordered destinations', async () => {
  const hostProfile = db.hostProfile as any;

  // First read with no profile row: empty identity, no error.
  assert.deepEqual(await caller().events.hostDestinations.get(), { handle: null, destinations: [] });

  // Save upserts the handle (normalized: no @, lowercase) and ordered list.
  let upsertArgs: any;
  hostProfile.upsert = async (args: any) => { upsertArgs = args; return {}; };
  const destinations = [
    { kind: 'instagram', value: 'MidtownJohn', primary: true },
    { kind: 'music', value: 'https://music.example.com/host' },
  ];
  const saved = await caller().events.hostDestinations.save({ handle: '@MidtownJohn', destinations });
  assert.equal(saved.handle, 'midtownjohn');
  assert.deepEqual(upsertArgs.where, { userId: 'test-user-id' });
  assert.equal(upsertArgs.update.handle, 'midtownjohn');
  assert.deepEqual(upsertArgs.update.hostDestinations, destinations);

  // All pills off is a valid saved state.
  assert.deepEqual((await caller().events.hostDestinations.save({ handle: null, destinations: [] })).destinations, []);

  // Socials take handles; links must be HTTPS; one primary max; no duplicate kinds.
  await assert.rejects(() => caller().events.hostDestinations.save({ destinations: [{ kind: 'instagram', value: 'https://instagram.com/host' }] }));
  await assert.rejects(() => caller().events.hostDestinations.save({ destinations: [{ kind: 'music', value: 'http://insecure.example.com' }] }));
  await assert.rejects(() => caller().events.hostDestinations.save({ destinations: [{ kind: 'music', value: 'https://a.example.com', primary: true }, { kind: 'website', value: 'https://b.example.com', primary: true }] }));
  await assert.rejects(() => caller().events.hostDestinations.save({ destinations: [{ kind: 'instagram', value: 'a' }, { kind: 'instagram', value: 'b' }] }));

  // Handle collisions surface as CONFLICT.
  hostProfile.upsert = async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }); };
  await assert.rejects(() => caller().events.hostDestinations.save({ handle: 'taken', destinations: [] }), { code: 'CONFLICT' });

  // Corrupt stored JSON fails closed to empty instead of leaking.
  hostProfile.findUnique = async () => ({ handle: 'midtownjohn', hostDestinations: { musicUrl: 'javascript:alert(1)' } });
  assert.deepEqual(await caller().events.hostDestinations.get(), { handle: 'midtownjohn', destinations: [] });
});

test('Invite projects the Official Host identity block with no raw URLs as labels', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', templateId: 'listening-party', title: 'First Listen', tagline: '', requiredMembershipTier: 'green',
    accessMode: 'free-rsvp', capacity: 80, locationDisclosure: 'public', venueName: 'Sample Venue',
    hostDestinations: { identity: true, handle: 'midtownjohn', destinations: [
      { kind: 'instagram', value: 'MidtownJohn', primary: true },
      { kind: 'tiktok', value: '@midtownjohn' },
      { kind: 'music', value: 'https://music.example.com/host' },
    ] },
    startsAt: new Date('2026-08-10T20:00:00Z'), endsAt: null, shareLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    itinerary: [], ticketTiers: [], host: { name: 'John' }, media: [],
  });
  const invite = await caller().events.invite({ partyId: 'party-1' });
  assert.equal(invite.host.handle, 'midtownjohn');
  assert.deepEqual(invite.host.destinationList, [
    { kind: 'instagram', label: '@MidtownJohn', url: 'https://instagram.com/MidtownJohn', primary: true },
    { kind: 'tiktok', label: '@midtownjohn', url: 'https://tiktok.com/@midtownjohn', primary: false },
    { kind: 'music', label: 'Music', url: 'https://music.example.com/host', primary: false },
  ]);
  // Legacy object stays empty when the identity snapshot is present.
  assert.deepEqual(invite.host.destinations, {});

  // Legacy parties (old snapshot shape) still project the legacy object.
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', templateId: 'listening-party', title: 'First Listen', tagline: '', requiredMembershipTier: 'green',
    accessMode: 'free-rsvp', capacity: 80, locationDisclosure: 'public', venueName: 'Sample Venue',
    hostDestinations: { musicUrl: 'https://music.example.com/host', primarySocial: { platform: 'Instagram', url: 'https://instagram.com/host' } },
    startsAt: new Date('2026-08-10T20:00:00Z'), endsAt: null, shareLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    itinerary: [], ticketTiers: [], host: { name: 'John' }, media: [],
  });
  const legacy = await caller().events.invite({ partyId: 'party-1' });
  assert.equal(legacy.host.handle, null);
  assert.deepEqual(legacy.host.destinationList, []);
  assert.equal((legacy.host.destinations as any).musicUrl, 'https://music.example.com/host');
});

test('Run of Show slice 1: endsAt persists, derives from the last beat, and projects absolute times', async () => {
  let createData: any;
  party.create = async ({ data }: any) => { createData = data; return { id: 'party-1' }; };
  // Dedicated user: drafts.create rate-limits per user and earlier tests
  // consume test-user-id's budget.
  const runOfShowCaller = () => createCaller({ user: { userId: 'run-of-show-user', email: 'ros@bytspot.com' }, clientRateLimitKey: 'test-party-client' });

  // Explicit host end wins.
  await runOfShowCaller().events.drafts.create({ ...draftInput, endsAt: '2026-08-11T02:00:00Z' });
  assert.equal(createData.endsAt.toISOString(), '2026-08-11T02:00:00.000Z');

  // No explicit end: last itinerary beat + 60 minutes closes the party.
  await runOfShowCaller().events.drafts.create({ ...draftInput, itinerary: [{ title: 'Doors open', offsetMinutes: 0 }, { title: 'Headliner', offsetMinutes: 120 }] });
  assert.equal(createData.endsAt.toISOString(), '2026-08-10T23:00:00.000Z');

  // No end and no beats: endsAt stays null (share-link 6h fallback applies).
  await runOfShowCaller().events.drafts.create({ ...draftInput, itinerary: [] });
  assert.equal(createData.endsAt, null);

  // End before start and >7-day runs are rejected.
  await assert.rejects(() => runOfShowCaller().events.drafts.create({ ...draftInput, endsAt: '2026-08-10T19:00:00Z' }));
  await assert.rejects(() => runOfShowCaller().events.drafts.create({ ...draftInput, endsAt: '2026-08-18T20:00:01Z' }));

  // The invite projects endsAt and the absolute schedule for each beat.
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', templateId: 'listening-party', title: 'First Listen', tagline: '', requiredMembershipTier: 'green',
    accessMode: 'free-rsvp', capacity: 80, locationDisclosure: 'public', venueName: 'Sample Venue', hostDestinations: null,
    startsAt: new Date('2026-08-10T20:00:00Z'), endsAt: new Date('2026-08-11T02:00:00Z'), shareLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    itinerary: [{ title: 'Doors open', offsetMinutes: 0 }, { title: 'Headliner', offsetMinutes: 120 }],
    ticketTiers: [], host: { name: 'Ava' }, media: [],
  });
  const invite = await caller().events.invite({ partyId: 'party-1' });
  assert.equal(invite.endsAt, '2026-08-11T02:00:00.000Z');
  assert.deepEqual(invite.runOfShow, [
    { title: 'Doors open', scheduledAt: '2026-08-10T20:00:00.000Z' },
    { title: 'Headliner', scheduledAt: '2026-08-10T22:00:00.000Z' },
  ]);
});
