import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const hostContext: Context = { user: { userId: 'host-user', email: 'host@bytspot.com' }, clientRateLimitKey: 'test-control-host' };
const guestContext: Context = { user: { userId: 'guest-user', email: 'guest@bytspot.com' }, clientRateLimitKey: 'test-control-guest' };
const credential = 'A'.repeat(43);
const idempotencyKey = '00000000-0000-4000-8000-000000000011';
const partyEndsAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
const publishedParty = { id: 'party-1', hostUserId: 'host-user', status: 'published', title: 'First Listen', capacity: 80, admissionPaused: false, startsAt: new Date(Date.now() + 60 * 60 * 1000), endsAt: partyEndsAt, shareLinkExpiresAt: null, passCode: 'BYT-EXISTING' };
const party = db.party as any;
const partyGuest = db.partyGuest as any;
const user = db.user as any;
const prisma = db as any;

function caller(context = hostContext) {
  return createCaller(context);
}

beforeEach(() => {
  party.findFirst = async () => publishedParty;
  party.findMany = async () => [];
  party.updateMany = async () => ({ count: 1 });
  partyGuest.count = async () => 0;
  partyGuest.findMany = async () => [];
  partyGuest.findUnique = async () => null;
  partyGuest.findFirst = async () => null;
  partyGuest.update = async ({ data }: any) => ({ id: 'guest-1', ...data });
  partyGuest.updateMany = async () => ({ count: 1 });
  partyGuest.upsert = async ({ create }: any) => ({ id: 'guest-1', ...create });
  user.findUnique = async () => ({ membershipTier: 'green' });
  prisma.$transaction = async (callback: any) => callback({ party, partyGuest });
});

test('Hosted rooms list is authenticated and returns only this host\'s published parties', async () => {
  const publicCaller = createCaller({ user: null, clientRateLimitKey: 'test-control-anon' });
  await assert.rejects(() => publicCaller.events.control.hosted(), { code: 'UNAUTHORIZED' });

  let listedWhere: any;
  party.findMany = async ({ where, take }: any) => {
    listedWhere = where;
    assert.equal(take, 50);
    return [{
      id: 'party-1', title: 'First Listen', venueName: 'The Basement',
      startsAt: publishedParty.startsAt, endsAt: publishedParty.endsAt,
      admissionPaused: false, shareLinkExpiresAt: null, passCode: 'BYT-EXISTING', capacity: 80,
    }];
  };
  const { parties } = await caller().events.control.hosted();
  assert.deepEqual(listedWhere, { hostUserId: 'host-user', status: 'published' });
  assert.equal(parties.length, 1);
  assert.equal(parties[0].id, 'party-1');
  assert.equal(parties[0].title, 'First Listen');
  assert.equal(parties[0].venueName, 'The Basement');
  assert.equal(parties[0].shareLinkExpiresAt, partyEndsAt.toISOString());
  assert.equal(parties[0].shareLinkExpired, false);
  assert.equal(parties[0].shareUrl, 'https://bytspot.app/party/party-1');
  assert.equal(parties[0].passCode, 'BYT-EXISTING');
});

test('Party Control routes require authentication and host ownership', async () => {
  const publicCaller = createCaller({ user: null, clientRateLimitKey: 'test-control-anon' });
  await assert.rejects(() => publicCaller.events.control.summary({ partyId: 'party-1' }), { code: 'UNAUTHORIZED' });

  let firstWhere: any;
  party.findFirst = async ({ where }: any) => {
    firstWhere = where;
    return null;
  };
  await assert.rejects(() => caller(guestContext).events.control.summary({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
  assert.deepEqual(firstWhere, { id: 'party-1', hostUserId: 'guest-user', status: 'published' });
  await assert.rejects(() => caller(guestContext).events.control.guests({ partyId: 'party-1', status: 'all' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller(guestContext).events.control.decide({ partyId: 'party-1', guestId: 'guest-1', decision: 'approved' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller(guestContext).events.control.checkIn({ partyId: 'party-1', attendeeCredential: credential }), { code: 'NOT_FOUND' });
});

test('Summary derives counts from PartyGuest rows in the iOS shape', async () => {
  const counts: Record<string, number> = { granted: 41, pending: 6, 'checked-in': 12 };
  partyGuest.count = async ({ where }: any) => where.accessGranted ? counts.granted : counts[where.status];
  const summary = await caller().events.control.summary({ partyId: 'party-1' });
  assert.deepEqual(summary, {
    partyId: 'party-1', title: 'First Listen', admissionPaused: false,
    capacity: 80, confirmed: 41, spacesRemaining: 39, pending: 6, checkedIn: 12,
    shareUrl: 'https://bytspot.app/party/party-1', passCode: 'BYT-EXISTING',
    shareLinkExpiresAt: partyEndsAt.toISOString(), shareLinkExpired: false, shareLinkExpiryIsDefault: true,
  });

  // Missing pass codes stay null — Control retrieves the issued code, it never mints a new one.
  party.findFirst = async () => ({ ...publishedParty, passCode: null });
  const withoutCode = await caller().events.control.summary({ partyId: 'party-1' });
  assert.equal(withoutCode.shareUrl, 'https://bytspot.app/party/party-1');
  assert.equal(withoutCode.passCode, null);
});

test('Guest list projects person fields and infers source from ticket tier', async () => {
  partyGuest.findMany = async () => [
    { id: 'guest-1', status: 'rsvp', ticketTierName: null, checkedInAt: null, user: { id: 'user-1', name: 'Ada', profileImage: null } },
    { id: 'guest-2', status: 'checked-in', ticketTierName: 'First Drop', checkedInAt: new Date('2026-08-10T21:00:00Z'), user: { id: 'user-2', name: null, profileImage: 'img' } },
  ];
  const { guests } = await caller().events.control.guests({ partyId: 'party-1', status: 'all' });
  assert.deepEqual(guests[0], {
    id: 'guest-1', status: 'rsvp', source: 'rsvp', ticketTierName: null, checkedInAt: null,
    person: { userId: 'user-1', name: 'Ada', profileImage: null },
  });
  assert.equal(guests[1].source, 'ticket');
  assert.equal(guests[1].checkedInAt, '2026-08-10T21:00:00.000Z');
  assert.equal(guests[1].person.name, 'Bytspot member');
});

test('setAdmissionPaused updates only a host-owned published Party', async () => {
  let updated: any;
  party.updateMany = async (input: any) => {
    updated = input;
    return { count: 1 };
  };
  assert.deepEqual(await caller().events.control.setAdmissionPaused({ partyId: 'party-1', paused: true }), { partyId: 'party-1', admissionPaused: true });
  assert.deepEqual(updated.where, { id: 'party-1', hostUserId: 'host-user', status: 'published' });
  assert.deepEqual(updated.data, { admissionPaused: true });

  party.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().events.control.setAdmissionPaused({ partyId: 'party-1', paused: false }), { code: 'NOT_FOUND' });
});

test('RSVP creation rejects new guests while admission is paused', async () => {
  party.findFirst = async () => ({ ...publishedParty, accessMode: 'free-rsvp', requiredMembershipTier: 'green', admissionPaused: true, host: { name: 'Host' }, media: [] });
  await assert.rejects(() => caller(guestContext).events.rsvp.create({ partyId: 'party-1', idempotencyKey }), { code: 'CONFLICT' });

  // A guest whose access was already granted still resolves their pass.
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'rsvp', accessGranted: true });
  const existing = await caller(guestContext).events.rsvp.create({ partyId: 'party-1', idempotencyKey });
  assert.deepEqual(existing, { status: 'rsvp', accessGranted: true });
});

test('decide approves or declines only pending guests and enforces capacity', async () => {
  partyGuest.findFirst = async () => ({ id: 'guest-1', partyId: 'party-1', status: 'rsvp' });
  await assert.rejects(() => caller().events.control.decide({ partyId: 'party-1', guestId: 'guest-1', decision: 'approved' }), { code: 'CONFLICT' });

  partyGuest.findFirst = async () => ({ id: 'guest-1', partyId: 'party-1', status: 'pending' });
  partyGuest.count = async () => 80;
  await assert.rejects(() => caller().events.control.decide({ partyId: 'party-1', guestId: 'guest-1', decision: 'approved' }), { code: 'CONFLICT' });

  partyGuest.count = async () => 10;
  let updateData: any;
  partyGuest.update = async ({ data }: any) => {
    updateData = data;
    return { id: 'guest-1', ...data };
  };
  assert.deepEqual(await caller().events.control.decide({ partyId: 'party-1', guestId: 'guest-1', decision: 'approved' }), {
    guestId: 'guest-1', status: 'approved', accessGranted: true,
  });
  assert.deepEqual(updateData, { status: 'approved', accessGranted: true });

  assert.deepEqual(await caller().events.control.decide({ partyId: 'party-1', guestId: 'guest-1', decision: 'declined' }), {
    guestId: 'guest-1', status: 'declined', accessGranted: false,
  });
});

test('decide never touches a guest row from another Party', async () => {
  let guestWhere: any;
  partyGuest.findFirst = async ({ where }: any) => {
    guestWhere = where;
    return null;
  };
  await assert.rejects(() => caller().events.control.decide({ partyId: 'party-1', guestId: 'foreign-guest', decision: 'approved' }), { code: 'NOT_FOUND' });
  assert.deepEqual(guestWhere, { id: 'foreign-guest', partyId: 'party-1' });
});

test('checkIn validates the credential format before any lookup', async () => {
  partyGuest.findUnique = async () => { throw new Error('must not query with an invalid credential'); };
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: 'short' }));
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: `${'A'.repeat(42)}=` }));
});

test('checkIn consumes a credential exactly once and only for this Party', async () => {
  partyGuest.findUnique = async () => null;
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: credential }), { code: 'NOT_FOUND' });

  partyGuest.findUnique = async () => ({ id: 'guest-1', partyId: 'other-party', status: 'rsvp', accessGranted: true, user: { name: 'Ada' } });
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: credential }), { code: 'NOT_FOUND' });

  partyGuest.findUnique = async () => ({ id: 'guest-1', partyId: 'party-1', status: 'rsvp', accessGranted: false, user: { name: 'Ada' } });
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: credential }), { code: 'NOT_FOUND' });

  partyGuest.findUnique = async () => ({ id: 'guest-1', partyId: 'party-1', status: 'checked-in', accessGranted: true, user: { name: 'Ada' } });
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: credential }), { code: 'CONFLICT' });

  partyGuest.findUnique = async () => ({ id: 'guest-1', partyId: 'party-1', status: 'rsvp', accessGranted: true, user: { name: 'Ada' } });
  let updated: any;
  partyGuest.updateMany = async (input: any) => {
    updated = input;
    return { count: 1 };
  };
  assert.deepEqual(await caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: credential }), { status: 'checked-in', guestName: 'Ada' });
  assert.deepEqual(updated.where, { id: 'guest-1', status: { not: 'checked-in' }, accessGranted: true });
  assert.equal(updated.data.status, 'checked-in');
  assert.ok(updated.data.checkedInAt instanceof Date);

  partyGuest.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().events.control.checkIn({ partyId: 'party-1', attendeeCredential: credential }), { code: 'CONFLICT' });
});

test('attendeeCredential is only issued to the authorized guest and is a stable 43-char base64url value', async () => {
  party.findFirst = async () => ({ id: 'party-1' });
  partyGuest.findUnique = async () => null;
  await assert.rejects(() => caller(guestContext).events.pass.attendeeCredential({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'pending', accessGranted: false, credential: null });
  await assert.rejects(() => caller(guestContext).events.pass.attendeeCredential({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'rsvp', accessGranted: true, credential: null });
  let issuedWhere: any;
  let issuedCredential = '';
  partyGuest.updateMany = async ({ where, data }: any) => {
    issuedWhere = where;
    issuedCredential = data.credential;
    return { count: 1 };
  };
  const issued = await caller(guestContext).events.pass.attendeeCredential({ partyId: 'party-1' });
  assert.equal(issued.partyId, 'party-1');
  assert.equal(issued.attendeeCredential, issuedCredential);
  assert.match(issued.attendeeCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(issuedWhere, { id: 'guest-1', credential: null });

  // A previously issued credential is returned unchanged.
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'rsvp', accessGranted: true, credential });
  partyGuest.updateMany = async () => { throw new Error('must not reissue an existing credential'); };
  assert.deepEqual(await caller(guestContext).events.pass.attendeeCredential({ partyId: 'party-1' }), { partyId: 'party-1', attendeeCredential: credential });
});

test('attendeeCredential returns the concurrently issued value after losing the race', async () => {
  let findCalls = 0;
  partyGuest.findUnique = async () => {
    findCalls += 1;
    return findCalls === 1
      ? { id: 'guest-1', status: 'rsvp', accessGranted: true, credential: null }
      : { id: 'guest-1', status: 'rsvp', accessGranted: true, credential };
  };
  partyGuest.updateMany = async () => ({ count: 0 });
  party.findFirst = async () => ({ id: 'party-1' });
  assert.deepEqual(await caller(guestContext).events.pass.attendeeCredential({ partyId: 'party-1' }), { partyId: 'party-1', attendeeCredential: credential });
});
