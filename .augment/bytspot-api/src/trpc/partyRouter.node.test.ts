import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
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
  resetLocalRateLimitForTests();
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
  partyGuest.updateMany = async () => ({ count: 0 });
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

test('Attendee credential is issued only to an access-granted guest and only its digest is persisted', async () => {
  let update: any;
  partyGuest.updateMany = async (input: any) => { update = input; return { count: 1 }; };

  const result = await caller().events.pass.attendeeCredential({ partyId: 'party-1' });
  assert.match(result.attendeeCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.partyId, 'party-1');
  assert.equal(update.where.userId, 'test-user-id');
  assert.equal(update.where.accessGranted, true);
  assert.equal(update.where.checkedInAt, null);
  assert.match(update.data.attendeeCredentialHash, /^[a-f0-9]{64}$/);
  assert.notEqual(update.data.attendeeCredentialHash, result.attendeeCredential);
});

test('Attendee credential rejects users without an active Party Pass', async () => {
  partyGuest.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().events.pass.attendeeCredential({ partyId: 'party-1' }), { code: 'FORBIDDEN' });
});

test('Door Mode checks in a valid credential exactly once and only for authorized staff', async () => {
  party.findFirst = async () => ({ hostUserId: 'test-user-id', cohosts: [] });
  partyGuest.findFirst = async () => ({ id: 'guest-1', checkedInAt: null, user: { name: 'Door Guest' } });
  let update: any;
  partyGuest.updateMany = async (input: any) => { update = input; return { count: 1 }; };

  const result = await caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: 'A'.repeat(43) });
  assert.deepEqual(result, { status: 'checked-in', guestName: 'Door Guest' });
  assert.equal(update.where.id, 'guest-1');
  assert.equal(update.where.checkedInAt, null);
  assert.match(update.where.attendeeCredentialHash, /^[a-f0-9]{64}$/);
  assert.ok(update.data.checkedInAt instanceof Date);

  partyGuest.updateMany = async () => ({ count: 0 });
  partyGuest.findUnique = async () => ({ checkedInAt: new Date() });
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: 'A'.repeat(43) }), { code: 'CONFLICT' });
});

test('Door Mode rejects all email-only cohost records and unknown credentials', async () => {
  party.findFirst = async () => ({ hostUserId: 'someone-else', cohosts: [{ email: 'test@bytspot.com', role: 'door' }] });
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: 'A'.repeat(43) }), { code: 'FORBIDDEN' });

  party.findFirst = async () => ({ hostUserId: 'test-user-id', cohosts: [] });
  partyGuest.findFirst = async () => null;
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: 'A'.repeat(43) }), { code: 'NOT_FOUND' });
});

test('Door Mode reports a rotated credential as expired instead of already checked in', async () => {
  party.findFirst = async () => ({ hostUserId: 'test-user-id' });
  partyGuest.findFirst = async () => ({ id: 'guest-1', checkedInAt: null, user: { name: 'Door Guest' } });
  partyGuest.updateMany = async () => ({ count: 0 });
  partyGuest.findUnique = async () => ({ checkedInAt: null });

  await assert.rejects(
    () => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: 'A'.repeat(43) }),
    { code: 'NOT_FOUND', message: 'Attendee credential expired. Ask the guest to refresh their pass.' },
  );
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
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'paid-ticket', ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }] });
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'declined', accessGranted: false });
  await assert.rejects(() => caller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey }), { code: 'FORBIDDEN' });

  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', capacity: 40 });
  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'FORBIDDEN' });
});

test('Free RSVP capacity is enforced inside a serializable transaction', async () => {
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 1 });
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
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 2 });
  prisma.$transaction = async () => { throw { code: 'P2034' }; };

  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'CONFLICT' });
});

test('Starting checkout clears a stale attendee credential from a non-granted guest', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40, title: 'First Listen', tagline: 'One moment.',
    ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
  });
  (config as any).stripeSecretKey = 'test-only-key';
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'checkout-pending', accessGranted: false, attendeeCredentialHash: 'stale-digest' });
  partyCheckout.findUnique = async () => null;
  partyCheckout.findFirst = async () => null;
  partyCheckout.count = async () => 0;
  let guestUpdate: any;
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1', ...input.data }; };
  const isolatedCaller = createCaller({ ...authenticatedContext, user: { userId: 'checkout-revocation-user', email: 'checkout-revocation@bytspot.test' } });
  await assert.rejects(() => isolatedCaller.events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey }));
  assert.deepEqual(guestUpdate.data, {
    status: 'checkout-pending', accessGranted: false, attendeeCredentialHash: null, ticketTierName: 'First Drop',
  });
});

test('Paid checkout retries return the persisted pending reservation', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40, title: 'First Listen', tagline: 'One moment.',
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
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40, title: 'First Listen', tagline: 'One moment.',
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
    id: 'party-1', title: 'Secret Set', tagline: 'See you there.', templateId: 'pop-up', requiredMembershipTier: 'black',
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
  party.findFirst = async () => ({ id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'black', capacity: 40, arrivalVenueId: null });
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
    id: 'party-1', status: 'published', accessMode: 'paid-ticket', requiredMembershipTier: 'green', capacity: 40,
    ticketTiers: [{ name: 'Black Table', priceCents: 2500, quantity: 40, requiredMembershipTier: 'black' }],
  });
  user.findUnique = async () => ({ membershipTier: 'platinum' });
  const isolatedCaller = createCaller({ ...authenticatedContext, user: { userId: 'tier-enforcement-user', email: 'tier-enforcement@bytspot.test' } });
  await assert.rejects(() => isolatedCaller.events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'Black Table', idempotencyKey }), { code: 'FORBIDDEN' });
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