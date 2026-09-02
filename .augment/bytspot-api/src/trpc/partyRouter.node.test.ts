import { randomUUID } from 'node:crypto';
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
const anonymousContext: Context = { user: null, clientRateLimitKey: 'test-party-anon' };
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
  const publicCaller = createCaller(anonymousContext);
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

test('Party draft creation enforces the Host Studio taxonomy instead of trusting its tags', async () => {
  // Dedicated user: party-draft-create allows 10 calls per user per minute and
  // the shared test user's budget is spent by the drafts tests above.
  const taxonomyCaller = () => createCaller({ user: { userId: 'taxonomy-user', email: 'taxonomy@bytspot.com' }, clientRateLimitKey: 'test-party-client' });

  // Nightlife runs a venue door, so a paid club night is accepted.
  await assert.doesNotReject(() => taxonomyCaller().events.drafts.create({
    ...draftInput, templateId: 'pop-up', accessMode: 'paid-ticket',
    ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 80, requiredMembershipTier: 'green' as const }],
    templateConfig: { kind: 'pop-up' as const, locationDisclosure: 'public', hostCategory: 'nightlife', hostType: 'club', hostFormat: 'lounge', hostAge: '21-plus' },
  }));

  // A house party is approval-only, and its category tag must match.
  await assert.rejects(() => taxonomyCaller().events.drafts.create({
    ...draftInput, templateId: 'private-party', accessMode: 'private-approval',
    templateConfig: { kind: 'private-party' as const, guestPolicy: 'named-guests', hostCategory: 'nightlife', hostType: 'house' },
  }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => taxonomyCaller().events.drafts.create({
    ...draftInput, templateId: 'pop-up', accessMode: 'free-rsvp',
    templateConfig: { kind: 'pop-up' as const, locationDisclosure: 'public', hostCategory: 'party', hostType: 'house' },
  }), { code: 'BAD_REQUEST' });

  // Unknown tags are rejected rather than stored.
  for (const config of [
    { hostCategory: 'nightlife', hostType: 'warehouse-rave' },
    { hostCategory: 'nightlife', hostType: 'club', hostFormat: 'submarine' },
    { hostCategory: 'nightlife', hostType: 'club', hostAge: '30-plus' },
  ]) {
    await assert.rejects(() => taxonomyCaller().events.drafts.create({
      ...draftInput, templateId: 'pop-up',
      templateConfig: { kind: 'pop-up' as const, locationDisclosure: 'public', ...config },
    }), { code: 'BAD_REQUEST' });
  }

  // Untagged drafts stay valid: the taxonomy is additive, not required.
  await assert.doesNotReject(() => taxonomyCaller().events.drafts.create(draftInput));
});

test('Party draft creation accepts withheld locations and rejects insecure official destinations', async () => {
  await assert.doesNotReject(() => caller().events.drafts.create({
    ...draftInput, locationDisclosure: 'withheld', templateId: 'comedy-night', templateConfig: { kind: 'standard' },
  }));
  await assert.rejects(() => caller().events.drafts.create({
    ...draftInput, hostDestinations: { primarySocial: { platform: 'instagram', url: 'https://instagram.com/host' }, websiteUrl: 'http://not-secure.example.com' },
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
  const invite = await createCaller(anonymousContext).events.invite({ partyId: 'party-1' });
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

// A heavily compressed 4K frame still fits the 600 KB ceiling, which is how a
// 3840x2160 cover reached production. Dimensions are checked independently.
test('Party media upload rejects oversized dimensions and accepts in-range ones', async () => {
  const png = (width: number, height: number) => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  };

  party.findFirst = async () => partyDraft;
  partyMedia.upsert = async () => ({ id: 'media-1' });

  await assert.rejects(() => caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: png(8000, 6000),
  }), { code: 'BAD_REQUEST' });

  assert.deepEqual(await caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: png(1600, 900),
  }), { url: 'https://bytspot-api.onrender.com/media/parties/media-1' });

  // A JPEG whose frame header is never reached must not be rejected outright;
  // the byte ceiling stays the only limit for anything we cannot measure.
  assert.deepEqual(await caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:image/jpeg;base64,/9j/',
  }), { url: 'https://bytspot-api.onrender.com/media/parties/media-1' });
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
  await assert.rejects(() => createCaller(anonymousContext).events.invite({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
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

test('Party Pass history lists only rooms the guest was admitted to and that are over', async () => {
  const hourMs = 60 * 60 * 1000;
  const room = (over: Record<string, unknown> = {}) => ({
    status: 'rsvp', checkedInAt: null,
    party: {
      id: 'party-1', title: 'First Listen', venueName: 'The Basement', locationDisclosure: 'public',
      startsAt: new Date(Date.now() - 8 * hourMs), endsAt: new Date(Date.now() - hourMs),
      recapPublishedAt: null, media: [],
      ...over,
    },
  });

  let listedWhere: any;
  let listedTake: number | undefined;
  partyGuest.findMany = async ({ where, take }: any) => {
    listedWhere = where; listedTake = take;
    return [room()];
  };

  const history = await caller().events.pass.history();
  assert.equal(listedWhere.userId, 'test-user-id');
  assert.equal(listedWhere.accessGranted, true);
  assert.equal(listedWhere.party.status, 'published');
  assert.equal(listedTake, 50);
  assert.equal(history.rooms.length, 1);
  assert.equal(history.rooms[0].id, 'party-1');
  assert.equal(history.rooms[0].recapAvailable, false);
  assert.equal(history.rooms[0].attended, false);

  // Whether a room is over is asked of the database, not trimmed off the
  // results. Trimming afterwards would let a page of rooms still to come push
  // a guest's finished rooms out of reach entirely.
  const [ended, fallback] = listedWhere.party.OR;
  assert.equal(fallback.endsAt, null);
  // `lte`, not `lt`: a room whose stated end is exactly now is over, and so is
  // one with no stated end that started exactly six hours ago. Pinning the
  // operator pins both equality boundaries.
  assert.deepEqual(Object.keys(ended.endsAt), ['lte']);
  assert.deepEqual(Object.keys(fallback.startsAt), ['lte']);
  const cutoff = Date.now() - 6 * hourMs;
  assert.ok(Math.abs(fallback.startsAt.lte.getTime() - cutoff) < 5_000, 'six hours is the assumed run without a stated end');

  // The location obeys the same disclosure the Party Pass obeys: a room the
  // host kept unplaced must not be named by the list that leads back to it.
  for (const disclosure of ['withheld', 'after-approval']) {
    partyGuest.findMany = async () => [room({ locationDisclosure: disclosure })];
    const listed = (await caller().events.pass.history()).rooms[0];
    assert.equal(listed.locationLabel, null, `${disclosure} must not name the venue`);
    assert.equal(listed.locationDisclosure, disclosure);
    assert.equal(JSON.stringify(listed).includes('The Basement'), false, 'the venue must not survive anywhere in the row');
  }
  partyGuest.findMany = async () => [room()];
  assert.equal((await caller().events.pass.history()).rooms[0].locationLabel, 'The Basement');

  // Staged photos are not a recap to a guest: unpublished counts as none.
  partyGuest.findMany = async () => [room({ media: [{ id: 'media-1' }, { id: 'media-2' }] })];
  let listed = (await caller().events.pass.history()).rooms[0];
  assert.equal(listed.recapAvailable, false, 'an unpublished album must not be advertised');
  assert.equal(listed.recapPhotoCount, 0);

  // Published, and the count is the one events.recap.get would serve.
  partyGuest.findMany = async () => [room({ media: [{ id: 'media-1' }, { id: 'media-2' }], recapPublishedAt: new Date() })];
  listed = (await caller().events.pass.history()).rooms[0];
  assert.equal(listed.recapAvailable, true);
  assert.equal(listed.recapPhotoCount, 2);

  // Checking in is reported, but it is never what makes a room reachable.
  partyGuest.findMany = async () => [{ ...room(), checkedInAt: new Date() }];
  assert.equal((await caller().events.pass.history()).rooms[0].attended, true);

  await assert.rejects(() => createCaller({ user: null, clientRateLimitKey: 'anon' }).events.pass.history(), { code: 'UNAUTHORIZED' });
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
  assert.deepEqual(updateArgs.where, { id: 'party-1', hostUserId: 'test-user-id', status: 'published', closedAt: null });
  assert.deepEqual(updateArgs.data, { shareLinkExpiresAt: future });

  await assert.rejects(
    () => caller().events.control.setShareLinkExpiry({ partyId: 'party-1', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    { code: 'BAD_REQUEST' },
  );

  // Null restores the default policy (dies at party end).
  const restored = await caller().events.control.setShareLinkExpiry({ partyId: 'party-1', expiresAt: null });
  assert.equal(restored.shareLinkExpiryIsDefault, true);
});

test('Closed rooms 404 unconfirmed arrivals even if the share link was extended, but host and confirmed guests still resolve', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const closedParty = {
    id: 'party-1', status: 'published', accessMode: 'free-rsvp', requiredMembershipTier: 'green', capacity: 40, arrivalVenueId: null,
    title: 'Closed Set', tagline: 'Done.', templateId: 'pop-up', venueName: 'Somewhere', locationDisclosure: 'public',
    itinerary: [], ticketTiers: [], hostDestinations: null, host: { name: 'Host' }, media: [],
    startsAt: future, endsAt: future, shareLinkExpiresAt: future, closedAt: new Date(), hostUserId: 'host-user',
  };
  party.findFirst = async () => closedParty;
  partyGuest.findUnique = async () => null;

  await assert.rejects(() => caller().events.pass.resolve({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'NOT_FOUND' });

  const closedTicketed = {
    ...closedParty,
    accessMode: 'paid-ticket',
    ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
  };
  party.findFirst = async () => closedTicketed;
  const closedCaller = () => createCaller({ user: { userId: 'closed-link-user', email: 'closed@bytspot.com' }, clientRateLimitKey: 'test-party-client' });
  user.findUnique = async () => ({ membershipTier: 'green' });
  await assert.rejects(() => closedCaller().events.tickets.createCheckout({ partyId: 'party-1', ticketTierName: 'First Drop', idempotencyKey }), { code: 'NOT_FOUND' });

  party.findFirst = async () => closedParty;
  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  const pass = await caller().events.pass.resolve({ partyId: 'party-1' });
  assert.equal(pass.action, 'view-pass');
  assert.equal(pass.guest.accessGranted, true);

  partyGuest.findUnique = async () => null;
  const hostCaller = createCaller({ user: { userId: 'host-user', email: 'host@bytspot.com' }, clientRateLimitKey: 'test-party-host' });
  const hostPass = await hostCaller.events.pass.resolve({ partyId: 'party-1' });
  assert.equal(hostPass.action, 'view-pass');
  assert.equal(hostPass.guest.accessGranted, true);
});

test('setShareLinkExpiry refuses a closed room and works again after reopen', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const openParty = {
    id: 'party-1', hostUserId: 'test-user-id', status: 'published',
    startsAt: new Date(Date.now() + 60 * 60 * 1000), endsAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    shareLinkExpiresAt: null, closedAt: null,
  };
  party.findFirst = async () => ({ ...openParty, closedAt: new Date() });
  let wrote = false;
  party.updateMany = async () => { wrote = true; return { count: 1 }; };
  await assert.rejects(
    () => caller().events.control.setShareLinkExpiry({ partyId: 'party-1', expiresAt: future.toISOString() }),
    { code: 'BAD_REQUEST' },
  );
  assert.equal(wrote, false);

  await caller().events.control.reopen({ partyId: 'party-1' });
  party.findFirst = async () => openParty;
  wrote = false;
  const result = await caller().events.control.setShareLinkExpiry({ partyId: 'party-1', expiresAt: future.toISOString() });
  assert.equal(result.shareLinkExpiresAt, future.toISOString());
  assert.equal(wrote, true);
});

test('Official Host identity lives on the host profile: handle + ordered destinations', async () => {
  const hostProfile = db.hostProfile as any;

  // First read with no profile row: empty identity, no error.
  assert.deepEqual(await caller().events.hostDestinations.get(), { handle: null, destinations: [] });

  // Save upserts the handle (normalized: no @, lowercase) and ordered list.
  let upsertArgs: any;
  hostProfile.upsert = async (args: any) => { upsertArgs = args; return {}; };
  const destinations = [
    { kind: 'instagram' as const, value: 'MidtownJohn', primary: true },
    { kind: 'music' as const, value: 'https://music.example.com/host' },
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

  // A crafted URL as the legacy platform never renders as public text.
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', templateId: 'listening-party', title: 'First Listen', tagline: '', requiredMembershipTier: 'green',
    accessMode: 'free-rsvp', capacity: 80, locationDisclosure: 'public', venueName: 'Sample Venue',
    hostDestinations: { primarySocial: { platform: 'https://evil.example.com', url: 'https://instagram.com/host' } },
    startsAt: new Date('2026-08-10T20:00:00Z'), endsAt: null, shareLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    itinerary: [], ticketTiers: [], host: { name: 'John' }, media: [],
  });
  const sanitized = await caller().events.invite({ partyId: 'party-1' });
  assert.equal((sanitized.host.destinations as any).primarySocial.platform, 'Social');
});

test('Invite projects published cover and album as HTTPS media URLs', async () => {
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', templateId: 'listening-party', title: 'First Listen', tagline: '', requiredMembershipTier: 'green',
    accessMode: 'private-approval', capacity: 80, locationDisclosure: 'after-approval', venueName: 'Sample Venue',
    hostDestinations: {}, startsAt: new Date('2026-08-10T20:00:00Z'), endsAt: null, shareLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    itinerary: [], ticketTiers: [], host: { name: 'John' },
    media: [
      { id: 'cover-1', kind: 'cover', position: 0 },
      { id: 'album-0', kind: 'album', position: 0 },
      { id: 'album-1', kind: 'album', position: 1 },
    ],
  });
  const invite = await createCaller(anonymousContext).events.invite({ partyId: 'party-1' });
  assert.match(invite.heroImageURL ?? '', /\/media\/parties\/cover-1$/);
  assert.match(invite.thumbnailURL ?? '', /\/media\/parties\/cover-1$/);
  assert.deepEqual(invite.photoURLs.map((url: string) => url.split('/').pop()), ['album-0', 'album-1']);
  for (const url of [invite.heroImageURL, invite.thumbnailURL, ...invite.photoURLs]) {
    assert.match(url ?? '', /^https:\/\//);
  }
});

test('Publish snapshots a handle-only Official Host identity onto the party', async () => {
  let savedSnapshot: any;
  (db.hostProfile as any).findUnique = async () => ({ handle: 'midtownjohn', hostDestinations: [] });
  party.findFirst = async () => partyDraft;
  party.updateMany = async ({ data }: any) => {
    if (data.hostDestinations) savedSnapshot = data.hostDestinations;
    return { count: 1 };
  };
  const result = await caller().events.publish({ partyId: 'party-1', idempotencyKey });
  assert.equal(result.id, 'party-1');
  assert.deepEqual(savedSnapshot, { identity: true, handle: 'midtownjohn', destinations: [] });
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

test('A host holds a confirmed pass to their own party regardless of tier or access mode', async () => {
  // A host is not a guest of their own party, so without an explicit host
  // branch they fall through to "membership-required" (or get asked to buy a
  // ticket to their own room) and arrival guidance stays locked.
  party.findFirst = async () => ({
    id: 'party-1', hostUserId: 'test-user-id', status: 'published', accessMode: 'paid-ticket',
    requiredMembershipTier: 'platinum', capacity: 20, startsAt: new Date(Date.now() + 86_400_000),
    endsAt: null, shareLinkExpiresAt: null, arrivalVenueId: 'venue-1',
    ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 20, requiredMembershipTier: 'platinum' }],
  });
  partyGuest.findUnique = async () => null;
  user.findUnique = async () => ({ membershipTier: 'green' });

  const pass = await caller().events.pass.resolve({ partyId: 'party-1' });
  assert.equal(pass.action, 'view-pass');
  assert.equal(pass.guest.accessGranted, true);
  assert.equal(pass.guest.status, 'host');
});

test('A non-host on the same party is still gated by membership tier', async () => {
  party.findFirst = async () => ({
    id: 'party-1', hostUserId: 'someone-else', status: 'published', accessMode: 'paid-ticket',
    requiredMembershipTier: 'platinum', capacity: 20, startsAt: new Date(Date.now() + 86_400_000),
    endsAt: null, shareLinkExpiresAt: null, arrivalVenueId: 'venue-1', ticketTiers: [],
  });
  partyGuest.findUnique = async () => null;
  user.findUnique = async () => ({ membershipTier: 'green' });

  const pass = await caller().events.pass.resolve({ partyId: 'party-1' });
  assert.equal(pass.action, 'unavailable');
  assert.equal(pass.guest.accessGranted, false);
});

test('A host still reaches their own party after the share link expires', async () => {
  const expired = {
    id: 'party-1', status: 'published', accessMode: 'rsvp', requiredMembershipTier: 'green', capacity: 20,
    startsAt: new Date(Date.now() - 8 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 60 * 60 * 1000),
    shareLinkExpiresAt: null, ticketTiers: [],
  };
  partyGuest.findUnique = async () => null;
  user.findUnique = async () => ({ membershipTier: 'green' });

  party.findFirst = async () => ({ ...expired, hostUserId: 'someone-else' });
  await assert.rejects(() => caller().events.pass.resolve({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  party.findFirst = async () => ({ ...expired, hostUserId: 'test-user-id' });
  assert.equal((await caller().events.pass.resolve({ partyId: 'party-1' })).action, 'view-pass');
});

test('an RSVP tells the host once, and a repeat RSVP does not ring them again', async () => {
  const pushDevice = db.iOSPushDevice as any;
  const targeted: string[][] = [];
  pushDevice.findMany = async ({ where }: any) => { targeted.push(where.userId.in); return []; };
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'open', requiredMembershipTier: 'green', capacity: 40,
    hostUserId: 'usr_host', startsAt: new Date(Date.now() + 3_600_000), endsAt: null, shareLinkExpiresAt: null,
    admissionPaused: false, ticketTiers: [],
  });
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'published' });
  user.findUnique = async () => ({ membershipTier: 'green', name: 'Ama Boateng' });
  partyGuest.findUnique = async () => null;
  partyGuest.count = async () => 0;
  partyGuest.upsert = async () => ({ status: 'rsvp', accessGranted: true });

  await caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(targeted, [['usr_host']], 'the host, and only the host, is told a guest is coming');

  // The same member re-opening their pass is not a new arrival.
  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  await caller().events.rsvp.create({ partyId: 'party-1', idempotencyKey });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(targeted.length, 1, 'a repeat RSVP must not notify the host again');
});

test('a guest list row that appeared concurrently does not ring the host twice', async () => {
  const pushDevice = db.iOSPushDevice as any;
  let sends = 0;
  pushDevice.findMany = async () => { sends += 1; return []; };
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'open', requiredMembershipTier: 'green', capacity: 40,
    hostUserId: 'usr_host', startsAt: new Date(Date.now() + 3_600_000), endsAt: null, shareLinkExpiresAt: null,
    admissionPaused: false, ticketTiers: [],
  });
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'published' });
  user.findUnique = async () => ({ membershipTier: 'green', name: 'Ama' });
  partyGuest.count = async () => 0;
  partyGuest.upsert = async () => ({ status: 'rsvp', accessGranted: true });

  // The pre-transaction read sees nobody, but by the time the transaction
  // runs another request has already added this member. Notification must
  // follow the state read inside the transaction, not the stale one.
  let reads = 0;
  partyGuest.findUnique = async () => {
    reads += 1;
    return reads === 1 ? null : { status: 'rsvp', accessGranted: false };
  };

  const concurrentCaller = createCaller({ user: { userId: 'usr_concurrent', email: 'c@bytspot.com' }, clientRateLimitKey: 'test-party-client' });
  await concurrentCaller.events.rsvp.create({ partyId: 'party-1', idempotencyKey });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0, 'the host is told when the guest joins the list, and only then');
});

test('a name lookup failure still delivers the alert and never fails the RSVP', async () => {
  const pushDevice = db.iOSPushDevice as any;
  const targeted: string[][] = [];
  pushDevice.findMany = async ({ where }: any) => { targeted.push(where.userId.in); return []; };
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'open', requiredMembershipTier: 'green', capacity: 40,
    hostUserId: 'usr_host', startsAt: new Date(Date.now() + 3_600_000), endsAt: null, shareLinkExpiresAt: null,
    admissionPaused: false, ticketTiers: [],
  });
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'published' });
  partyGuest.findUnique = async () => null;
  partyGuest.count = async () => 0;
  partyGuest.upsert = async () => ({ status: 'rsvp', accessGranted: true });

  let membershipRead = false;
  user.findUnique = async () => {
    // The membership read that gates the RSVP must still succeed; only the
    // later cosmetic name lookup fails.
    if (!membershipRead) { membershipRead = true; return { membershipTier: 'green' }; }
    throw new Error('user lookup failed');
  };

  const enrichCaller = createCaller({ user: { userId: 'usr_enrich', email: 'e@bytspot.com' }, clientRateLimitKey: 'test-party-client' });
  const result = await enrichCaller.events.rsvp.create({ partyId: 'party-1', idempotencyKey: randomUUID() });
  assert.deepEqual(result, { status: 'rsvp', accessGranted: true }, 'the RSVP stands even when its notification copy cannot be enriched');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(targeted, [['usr_host']], 'the host is still told, under a generic name');
});

test('a failing push never turns a successful RSVP into an error', async () => {
  const pushDevice = db.iOSPushDevice as any;
  pushDevice.findMany = async () => { throw new Error('APNs is down'); };
  party.findFirst = async () => ({
    id: 'party-1', status: 'published', accessMode: 'open', requiredMembershipTier: 'green', capacity: 40,
    hostUserId: 'usr_host', startsAt: new Date(Date.now() + 3_600_000), endsAt: null, shareLinkExpiresAt: null,
    admissionPaused: false, ticketTiers: [],
  });
  user.findUnique = async () => ({ membershipTier: 'green', name: 'Ama' });
  partyGuest.findUnique = async () => null;
  partyGuest.count = async () => 0;
  partyGuest.upsert = async () => ({ status: 'rsvp', accessGranted: true });

  const pushFailCaller = createCaller({ user: { userId: 'usr_pushfail', email: 'p@bytspot.com' }, clientRateLimitKey: 'test-party-client' });
  const result = await pushFailCaller.events.rsvp.create({ partyId: 'party-1', idempotencyKey: randomUUID() });
  assert.deepEqual(result, { status: 'rsvp', accessGranted: true });
  await new Promise((resolve) => setImmediate(resolve));
});

test('Invite coordinates require a public venue and a real arrival Venue', async () => {
  const venue = { id: 'venue-1', name: 'Sample Venue', lat: 33.7841, lng: -84.3830 };
  const base = {
    id: 'party-1', status: 'published', templateId: 'listening-party', title: 'First Listen', tagline: '', requiredMembershipTier: 'green',
    accessMode: 'free-rsvp', capacity: 80, venueName: 'Sample Venue', hostDestinations: {},
    startsAt: new Date('2026-08-10T20:00:00Z'), endsAt: null, shareLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    itinerary: [], ticketTiers: [], host: { name: 'John' }, media: [],
  };

  // Public venue with an attached arrival Venue: the point is already public.
  party.findFirst = async () => ({ ...base, locationDisclosure: 'public', arrivalVenue: venue });
  const routable = await createCaller(anonymousContext).events.invite({ partyId: 'party-1' });
  assert.equal(routable.latitude, 33.7841);
  assert.equal(routable.longitude, -84.3830);

  // Public label but free-text venue (no arrival Venue): nothing to route to.
  party.findFirst = async () => ({ ...base, locationDisclosure: 'public', arrivalVenue: null });
  const unmapped = await createCaller(anonymousContext).events.invite({ partyId: 'party-1' });
  assert.equal(unmapped.latitude, null);
  assert.equal(unmapped.longitude, null);

  // A coordinate must never outrun the label it is meant to respect.
  for (const disclosure of ['after-approval', 'withheld']) {
    party.findFirst = async () => ({ ...base, locationDisclosure: disclosure, arrivalVenue: venue });
    const hidden = await createCaller(anonymousContext).events.invite({ partyId: 'party-1' });
    assert.equal(hidden.locationLabel, null, `${disclosure} must not publish a label`);
    assert.equal(hidden.latitude, null, `${disclosure} must not leak latitude`);
    assert.equal(hidden.longitude, null, `${disclosure} must not leak longitude`);
  }
});

// A recap is the room from the inside, so unlike cover and album it is a second
// authorization surface: existence, count, and bytes are all gated on the door.
const stagedRecap = {
  id: 'party-1', status: 'published', hostUserId: 'host-1', recapPublishedAt: null,
  title: 'First Listen', media: [{ id: 'recap-1', position: 0 }, { id: 'recap-2', position: 1 }],
};

test('A staged recap is invisible to everyone except its host', async () => {
  party.findUnique = async () => stagedRecap;

  // Anonymous and a signed-in stranger are indistinguishable from no recap.
  await assert.rejects(() => createCaller(anonymousContext).events.recap.get({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller().events.recap.get({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  // So is a confirmed guest, while the host is still staging.
  partyGuest.findUnique = async () => ({ accessGranted: true });
  await assert.rejects(() => caller().events.recap.get({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  // The host reviews their own unpublished album.
  const hostView = await createCaller({ user: { userId: 'host-1', email: 'host@bytspot.com' }, clientRateLimitKey: 'test-recap-host' }).events.recap.get({ partyId: 'party-1' });
  assert.equal(hostView.publishedAt, null);
  assert.equal(hostView.photoURLs.length, 2);
});

test('A published recap opens to the guests the door admitted, and nobody else', async () => {
  const publishedAt = new Date('2026-08-11T04:00:00Z');
  party.findUnique = async () => ({ ...stagedRecap, recapPublishedAt: publishedAt });

  // A guest row with access withdrawn, declined, or still pending gets the same
  // NOT_FOUND as a party with no recap.
  partyGuest.findUnique = async () => ({ accessGranted: false });
  await assert.rejects(() => caller().events.recap.get({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  let guestLookup: any;
  partyGuest.findUnique = async (input: any) => { guestLookup = input.where; return { accessGranted: true }; };
  const recap = await caller().events.recap.get({ partyId: 'party-1' });
  // Scoped to this party's guest list, not merely to a signed-in member who
  // holds a pass to some other party.
  assert.deepEqual(guestLookup, { partyId_userId: { partyId: 'party-1', userId: 'test-user-id' } });
  assert.equal(recap.publishedAt, publishedAt.toISOString());
  assert.deepEqual(recap.photoURLs, [`${config.publicApiUrl}/media/parties/recap-1`, `${config.publicApiUrl}/media/parties/recap-2`]);
});

test('A recap reports the position of each photo, so a sparse album stays addressable', async () => {
  // Position 1 was removed, so array index and position no longer agree. A host
  // surface keyed on the index would delete recap-4 when asked for recap-2, and
  // would overwrite recap-4 on the next upload.
  party.findUnique = async () => ({
    ...stagedRecap, recapPublishedAt: new Date('2026-08-11T04:00:00Z'),
    media: [{ id: 'recap-1', position: 0 }, { id: 'recap-2', position: 2 }, { id: 'recap-4', position: 5 }],
  });
  partyGuest.findUnique = async () => ({ accessGranted: true });

  const recap = await caller().events.recap.get({ partyId: 'party-1' });
  assert.deepEqual(recap.photos, [
    { id: 'recap-1', position: 0, url: `${config.publicApiUrl}/media/parties/recap-1` },
    { id: 'recap-2', position: 2, url: `${config.publicApiUrl}/media/parties/recap-2` },
    { id: 'recap-4', position: 5, url: `${config.publicApiUrl}/media/parties/recap-4` },
  ]);
  // photoURLs stays the ordered list a reader wants, in the same order.
  assert.deepEqual(recap.photoURLs, recap.photos.map((photo) => photo.url));
});

// The room is over: a party that has ended, so the recap window is open.
const overParty = { startsAt: new Date(Date.now() - 8 * 60 * 60 * 1000), endsAt: new Date(Date.now() - 60 * 60 * 1000) };
// Published, but the doors have not opened yet.
const upcomingParty = { startsAt: new Date(Date.now() + 60 * 60 * 1000), endsAt: new Date(Date.now() + 4 * 60 * 60 * 1000) };
const pngDataUri = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0x01, 0x40, 0, 0, 0x01, 0x40,
]).toString('base64')}`;

test('A recap closes to guests if the party leaves published, on both read surfaces', async () => {
  // The bytes route already pins this. The whole thesis is that the two
  // implementations of the read rule stay identical, so the tRPC surface has to
  // pin it too rather than inherit it by assumption.
  party.findUnique = async () => ({ ...stagedRecap, status: 'draft', recapPublishedAt: new Date('2026-08-11T04:00:00Z') });
  partyGuest.findUnique = async () => ({ accessGranted: true });
  await assert.rejects(() => caller().events.recap.get({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
  // The host still reviews their own album.
  const hostView = await createCaller({ user: { userId: 'host-1', email: 'host@bytspot.com' }, clientRateLimitKey: 'test-recap-host-2' }).events.recap.get({ partyId: 'party-1' });
  assert.equal(hostView.photoURLs.length, 2);
});

test('A recap cannot exist before the room does', async () => {
  // Nothing to recap until the party is over. Without this the whole path is
  // open from publish, which is before the party happens, and the alert could
  // reach everyone who RSVP'd to a party whose doors have not opened.
  party.findFirst = async () => ({ id: 'party-1', title: 'First Listen', recapPublishedAt: null, media: [{ id: 'recap-1' }], ...upcomingParty });
  await assert.rejects(() => caller().events.recap.upload({ partyId: 'party-1', index: 0, dataUri: pngDataUri }), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(() => caller().events.recap.publish({ partyId: 'party-1' }), { code: 'PRECONDITION_FAILED' });

  // A party with no explicit end falls back to the same 6-hour grace window the
  // share link uses, rather than being recappable the moment it starts.
  party.findFirst = async () => ({ id: 'party-1', title: 'First Listen', recapPublishedAt: null, media: [{ id: 'recap-1' }], startsAt: new Date(Date.now() - 60 * 60 * 1000), endsAt: null });
  await assert.rejects(() => caller().events.recap.publish({ partyId: 'party-1' }), { code: 'PRECONDITION_FAILED' });

  // A host who holds the share link open for a week has not made the party last
  // a week: the recap window follows the room, not the link.
  party.findFirst = async () => ({ id: 'party-1', title: 'First Listen', recapPublishedAt: null, media: [{ id: 'recap-1' }], ...overParty, shareLinkExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
  party.updateMany = async () => ({ count: 1 });
  assert.equal((await caller().events.recap.publish({ partyId: 'party-1' })).photoCount, 1);
});

test('Publishing a recap needs a photo, belongs to the host, and tells the room exactly once', async () => {
  let claims = 0;
  let where: any;
  party.updateMany = async (input: any) => { claims += 1; where = input.where; return { count: 1 }; };

  // Not the host, or not published: the party is simply not found.
  party.findFirst = async () => null;
  await assert.rejects(() => caller().events.recap.publish({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  // An empty album cannot be published, so the alert can never promise nothing.
  party.findFirst = async () => ({ id: 'party-1', title: 'First Listen', recapPublishedAt: null, media: [], ...overParty });
  await assert.rejects(() => caller().events.recap.publish({ partyId: 'party-1' }), { code: 'PRECONDITION_FAILED' });
  assert.equal(claims, 0);

  party.findFirst = async () => ({ id: 'party-1', title: 'First Listen', recapPublishedAt: null, media: [{ id: 'recap-1' }], ...overParty });
  const first = await caller().events.recap.publish({ partyId: 'party-1' });
  assert.equal(first.photoCount, 1);
  assert.equal(claims, 1);
  // The write is the test, not a prior read: only a row still at null can be
  // claimed, so a double-tap cannot notify the room twice.
  assert.deepEqual(where, { id: 'party-1', recapPublishedAt: null });
});

test('A losing concurrent publish reports the winner\'s moment and does not re-notify', async () => {
  // Both callers saw recapPublishedAt as null; only one can claim the column.
  const winnersMoment = new Date('2026-08-11T04:00:00Z');
  party.findFirst = async () => ({ id: 'party-1', title: 'First Listen', recapPublishedAt: null, media: [{ id: 'recap-1' }], ...overParty });
  party.updateMany = async () => ({ count: 0 });
  party.findUnique = async () => ({ recapPublishedAt: winnersMoment });

  const loser = await caller().events.recap.publish({ partyId: 'party-1' });
  assert.equal(loser.publishedAt, winnersMoment.toISOString());
});

test('An invitation reports that a recap exists without handing over its photos', async () => {
  const invited = {
    id: 'party-1', title: 'First Listen', tagline: 'One moment.', templateId: 'listening-party', requiredMembershipTier: 'green',
    status: 'published', venueName: 'Sample Venue', locationDisclosure: 'public', accessMode: 'free-rsvp',
    capacity: 80, hostDestinations: {}, itinerary: [], ticketTiers: [], host: { name: 'Host' }, ...linkAlive,
    media: [{ id: 'cover-1', kind: 'cover' }, { id: 'album-1', kind: 'album' }, { id: 'recap-1', kind: 'recap' }],
  };

  // Staged: the count stays at zero even for a guest who was in the room, so
  // the invitation does not leak that the host is assembling an album.
  party.findFirst = async () => ({ ...invited, recapPublishedAt: null, hostUserId: 'host-user' });
  partyGuest.findUnique = async () => ({ accessGranted: true, status: 'rsvp' });
  const staged = await caller().events.invite({ partyId: 'party-1' });
  assert.equal(staged.recapAvailable, false);
  assert.equal(staged.recapPhotoCount, 0);

  party.findFirst = async () => ({ ...invited, recapPublishedAt: new Date('2026-08-11T04:00:00Z'), hostUserId: 'host-user' });

  // Whoever may read the bytes may know the album is there, and nobody else.
  // A stranger holding the share link was never in the room: telling them a
  // recap of it exists confirms what the read rule refuses to, and would offer
  // the pass an album the server then declines to serve.
  const stranger = await createCaller(anonymousContext).events.invite({ partyId: 'party-1' });
  assert.equal(stranger.recapAvailable, false);
  assert.equal(stranger.recapPhotoCount, 0);

  // Signed in but not admitted is the same answer as never having been there.
  partyGuest.findUnique = async () => ({ accessGranted: false, status: 'pending' });
  const notAdmitted = await caller().events.invite({ partyId: 'party-1' });
  assert.equal(notAdmitted.recapAvailable, false);

  partyGuest.findUnique = async () => ({ accessGranted: true, status: 'rsvp' });
  const published = await caller().events.invite({ partyId: 'party-1' });
  assert.equal(published.recapAvailable, true);
  assert.equal(published.recapPhotoCount, 1);
  // Existence and a count only. Bytes come from events.recap.get, which
  // re-checks the guest list, so the invitation issues no recap URL at all.
  assert.deepEqual(published.photoURLs, [`${config.publicApiUrl}/media/parties/album-1`]);
  assert.equal(JSON.stringify(published).includes('recap-1'), false);

  // The host reads their own staged album, because the bytes route lets them.
  party.findFirst = async () => ({ ...invited, recapPublishedAt: null, hostUserId: 'test-user-id' });
  partyGuest.findUnique = async () => null;
  assert.equal((await caller().events.invite({ partyId: 'party-1' })).recapAvailable, true);
});

test('A recap photo can always be taken down, whatever state the party is in', async () => {
  let unpublished = false;
  party.updateMany = async (input: any) => {
    if (input.data?.recapPublishedAt === null) unpublished = true;
    return { count: 1 };
  };
  let deletedWhere: any;
  partyMedia.deleteMany = async (input: any) => { deletedWhere = input.where; return { count: 1 }; };
  partyMedia.count = async () => 2;

  // Only the host, and a stranger cannot learn the party exists.
  party.findFirst = async () => null;
  await assert.rejects(() => caller().events.recap.remove({ partyId: 'party-1', index: 0 }), { code: 'NOT_FOUND' });

  // Takedown has no window and no publish-state condition: an upcoming party,
  // a staged album, and a published one all remove the same way. Nothing about
  // the party's state may keep a photograph of someone up, so ownership is the
  // entire lookup — asserted on the query itself, since a mock would happily
  // return a party for any narrower where clause.
  let lookup: any;
  party.findFirst = async (input: any) => { lookup = input.where; return { id: 'party-1', recapPublishedAt: null, ...upcomingParty }; };
  const removed = await caller().events.recap.remove({ partyId: 'party-1', index: 3 });
  assert.deepEqual(lookup, { id: 'party-1', hostUserId: 'test-user-id' });
  // published is whether guests can see the album, not whether photos survived:
  // this one is still staged, so removing from it publishes nothing.
  assert.deepEqual(removed, { removed: true, remaining: 2, published: false });
  assert.deepEqual(deletedWhere, { partyId: 'party-1', kind: 'recap', position: 3 });
  assert.equal(unpublished, false);
});

test('A takedown names the photo, not the slot it happens to sit in', async () => {
  // A slot is reused the moment a photo is removed, so a host acting on a stale
  // album can ask for slot 2 and take down whatever replaced what they saw.
  // Deleting a photograph of the wrong person is the failure this operation
  // exists to prevent, so identity wins wherever the client can supply it.
  let deletedWhere: any;
  party.findFirst = async () => ({ id: 'party-1', recapPublishedAt: null, ...overParty });
  partyMedia.deleteMany = async (input: any) => { deletedWhere = input.where; return { count: 1 }; };
  partyMedia.count = async () => 1;

  await caller().events.recap.remove({ partyId: 'party-1', mediaId: 'recap-7' });
  // Scoped to this party's recap, so a media id belonging to another party or
  // to the cover cannot be deleted through the recap door.
  assert.deepEqual(deletedWhere, { id: 'recap-7', partyId: 'party-1', kind: 'recap' });

  // Naming neither is refused rather than guessed at.
  await assert.rejects(() => caller().events.recap.remove({ partyId: 'party-1' } as any), { name: 'TRPCError' });
});

test('An unslotted upload is allocated by the database, so two devices cannot claim one slot', async () => {
  party.findFirst = async () => ({ id: 'party-1', ...overParty });
  partyMedia.count = async () => 0;

  // Both devices see the same album and would both compute slot 1. The unique
  // index on (partyId, kind, position) decides it; the loser retries against
  // the album as it actually is rather than overwriting the winner.
  let existing = [{ position: 0 }];
  let creates = 0;
  partyMedia.findMany = async () => existing;
  partyMedia.create = async (input: any) => {
    creates += 1;
    if (creates === 1) {
      existing = [{ position: 0 }, { position: 1 }];
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
    return { id: 'recap-new', position: input.data.position };
  };

  const added = await caller().events.recap.upload({ partyId: 'party-1', dataUri: pngDataUri });
  assert.equal(creates, 2);
  assert.deepEqual(added, { id: 'recap-new', position: 2, url: `${config.publicApiUrl}/media/parties/recap-new` });

  // A full album is a conflict, never a silent overwrite.
  existing = Array.from({ length: 12 }, (_, position) => ({ position }));
  await assert.rejects(() => caller().events.recap.upload({ partyId: 'party-1', dataUri: pngDataUri }), { code: 'CONFLICT' });
});

test('A named slot still replaces, because a re-shoot of one photo is deliberate', async () => {
  party.findFirst = async () => ({ id: 'party-1', ...overParty });
  let upsertWhere: any;
  partyMedia.upsert = async (input: any) => { upsertWhere = input.where; return { id: 'recap-2', position: 2 }; };

  const replaced = await caller().events.recap.upload({ partyId: 'party-1', index: 2, dataUri: pngDataUri });
  assert.deepEqual(upsertWhere, { partyId_kind_position: { partyId: 'party-1', kind: 'recap', position: 2 } });
  assert.deepEqual(replaced, { id: 'recap-2', position: 2, url: `${config.publicApiUrl}/media/parties/recap-2` });
});

test('Taking down the last photo retracts the recap instead of leaving an empty room', async () => {
  // Publishing refuses an empty album, so published-with-zero-photos must not
  // be reachable from the other direction either.
  let retracted: any;
  party.findFirst = async () => ({ id: 'party-1', recapPublishedAt: new Date('2026-08-11T04:00:00Z'), ...overParty });
  party.updateMany = async (input: any) => { retracted = input; return { count: 1 }; };
  partyMedia.deleteMany = async () => ({ count: 1 });
  partyMedia.count = async () => 0;

  const removed = await caller().events.recap.remove({ partyId: 'party-1', index: 0 });
  assert.deepEqual(removed, { removed: true, remaining: 0, published: false });
  assert.deepEqual(retracted, { where: { id: 'party-1', recapPublishedAt: { not: null } }, data: { recapPublishedAt: null } });
});

test('Unpublishing retracts the album without destroying it, and repeats harmlessly', async () => {
  let updates = 0;
  partyMedia.deleteMany = async () => ({ count: 0 });
  party.updateMany = async () => { updates += 1; return { count: 1 } };

  party.findFirst = async () => null;
  await assert.rejects(() => caller().events.recap.unpublish({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  let lookup: any;
  party.findFirst = async (input: any) => { lookup = input.where; return { id: 'party-1', ...overParty }; };
  assert.deepEqual(await caller().events.recap.unpublish({ partyId: 'party-1' }), { published: false });
  // Ownership only: retraction must not be blocked by the window or by the
  // party's status either.
  assert.deepEqual(lookup, { id: 'party-1', hostUserId: 'test-user-id' });
  // Idempotent: a second call is a no-op rather than an error, and the photos
  // are still there to publish again.
  assert.deepEqual(await caller().events.recap.unpublish({ partyId: 'party-1' }), { published: false });
  assert.equal(updates, 2);
});

test('A retracted recap closes to guests again immediately', async () => {
  // The bytes route re-checks on every read, so retraction needs no cache
  // invalidation: recap.get applies the same rule and shuts at once.
  party.findUnique = async () => ({ ...stagedRecap, recapPublishedAt: null });
  partyGuest.findUnique = async () => ({ accessGranted: true });
  await assert.rejects(() => caller().events.recap.get({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
});
