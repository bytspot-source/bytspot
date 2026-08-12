import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const authenticatedContext: Context = { user: { userId: 'me', email: 'me@bytspot.com' }, clientRateLimitKey: 'test-social-client' };
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const user = db.user as any;
const socialInvitation = db.socialInvitation as any;
const socialCircle = db.socialCircle as any;
const socialCircleMember = db.socialCircleMember as any;
const contactHash = db.contactHash as any;
const partyEncounterOptIn = db.partyEncounterOptIn as any;
const party = db.party as any;
const partyGuest = db.partyGuest as any;
const prisma = db as any;

function caller(context = authenticatedContext) {
  return createCaller(context);
}

beforeEach(() => {
  user.findUnique = async () => ({ id: 'friend', name: 'Friend' });
  user.findMany = async () => [];
  socialInvitation.findMany = async () => [];
  socialInvitation.upsert = async ({ create }: any) => ({ id: 'invite-1', status: 'pending', createdAt: new Date('2026-08-01T00:00:00Z'), respondedAt: null, ...create });
  socialInvitation.updateMany = async () => ({ count: 1 });
  socialCircle.findFirst = async () => null;
  socialCircle.findMany = async () => [];
  socialCircle.create = async ({ data }: any) => ({ id: 'circle-1', createdAt: new Date(), ...data });
  socialCircleMember.upsert = async ({ create }: any) => ({ id: 'member-1', ...create });
  socialCircleMember.deleteMany = async () => ({ count: 1 });
  socialCircleMember.findMany = async () => [];
  contactHash.findMany = async () => [];
  contactHash.deleteMany = async () => ({ count: 0 });
  contactHash.createMany = async () => ({ count: 0 });
  partyEncounterOptIn.findUnique = async () => null;
  partyEncounterOptIn.findMany = async () => [];
  partyEncounterOptIn.upsert = async ({ create }: any) => ({ id: 'opt-1', ...create });
  partyEncounterOptIn.deleteMany = async () => ({ count: 1 });
  party.findFirst = async () => null;
  partyGuest.findUnique = async () => null;
  partyGuest.findMany = async () => [];
  prisma.$transaction = async (operations: any) => Array.isArray(operations) ? Promise.all(operations) : operations(prisma);
});

test('Social routes require authentication', async () => {
  const publicCaller = createCaller({ user: null, clientRateLimitKey: 'test-social-anon' });
  await assert.rejects(() => publicCaller.social.invites.list({ surface: 'network' }), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => publicCaller.social.suggestions(), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => publicCaller.social.groups.list({ surface: 'network' }), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => publicCaller.social.peopleMet.list({ partyId: 'party-1' }), { code: 'UNAUTHORIZED' });
});

test('Invite creation rejects self-invites and unknown members, and returns the iOS invitation shape', async () => {
  await assert.rejects(() => caller().social.invites.create({ targetType: 'user', targetValue: 'me', surface: 'network' }), { code: 'BAD_REQUEST' });

  user.findUnique = async () => null;
  await assert.rejects(() => caller().social.invites.create({ targetType: 'user', targetValue: 'ghost', surface: 'network' }), { code: 'NOT_FOUND' });

  user.findUnique = async () => ({ id: 'friend', name: 'Friend' });
  const invite = await caller().social.invites.create({ targetType: 'user', targetValue: 'friend', surface: 'network' });
  assert.equal(invite.id, 'invite-1');
  assert.equal(invite.direction, 'outgoing');
  assert.equal(invite.status, 'pending');
  assert.deepEqual(invite.person, { userId: 'friend', name: 'Friend' });
});

test('Invite creation only echoes a circle the caller owns', async () => {
  await assert.rejects(() => caller().social.invites.create({
    targetType: 'user', targetValue: 'friend', groupId: 'not-mine', surface: 'network',
  }), { code: 'NOT_FOUND' });

  socialCircle.findFirst = async ({ where }: any) => where.ownerId === 'me' ? { id: 'circle-1', name: 'Close Friends' } : null;
  const invite = await caller().social.invites.create({ targetType: 'user', targetValue: 'friend', groupId: 'circle-1', surface: 'network' });
  assert.equal(invite.groupId, 'circle-1');
  assert.equal(invite.groupName, 'Close Friends');
});

test('Invite list labels directions relative to the caller', async () => {
  socialInvitation.findMany = async () => [
    { id: 'in-1', fromUserId: 'friend', toUserId: 'me', status: 'pending', createdAt: new Date('2026-08-01T00:00:00Z'), respondedAt: null, fromUser: { id: 'friend', name: 'Friend' }, toUser: { id: 'me', name: 'Me' } },
    { id: 'out-1', fromUserId: 'me', toUserId: 'other', status: 'accepted', createdAt: new Date('2026-08-02T00:00:00Z'), respondedAt: new Date('2026-08-03T00:00:00Z'), fromUser: { id: 'me', name: 'Me' }, toUser: { id: 'other', name: ' ' } },
  ];
  const { invites } = await caller().social.invites.list({ surface: 'network' });
  assert.equal(invites.length, 2);
  assert.equal(invites[0].direction, 'incoming');
  assert.deepEqual(invites[0].person, { userId: 'friend', name: 'Friend' });
  assert.equal(invites[1].direction, 'outgoing');
  assert.deepEqual(invites[1].person, { userId: 'other', name: 'Bytspot member' });
});

test('Only the pending recipient can respond to an invitation', async () => {
  let updateWhere: any;
  socialInvitation.updateMany = async ({ where }: any) => {
    updateWhere = where;
    return { count: 1 };
  };
  const result = await caller().social.invites.respond({ inviteId: 'invite-1', response: 'accepted', surface: 'network' });
  assert.deepEqual(result, { inviteId: 'invite-1', status: 'accepted' });
  assert.deepEqual(updateWhere, { id: 'invite-1', toUserId: 'me', status: 'pending' });

  socialInvitation.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().social.invites.respond({ inviteId: 'invite-1', response: 'declined', surface: 'network' }), { code: 'NOT_FOUND' });
});

test('Contact sync rejects raw contact data and replaces the stored hash set', async () => {
  await assert.rejects(() => caller().social.syncCloudContact({ source: 'apple', hashes: ['friend@example.com'] }));

  let deleteWhere: any;
  let createManyData: any;
  contactHash.deleteMany = async ({ where }: any) => {
    deleteWhere = where;
    return { count: 1 };
  };
  contactHash.createMany = async ({ data }: any) => {
    createManyData = data;
    return { count: data.length };
  };
  contactHash.findMany = async () => [
    { userId: 'friend', hashedContact: hashA },
    { userId: 'friend', hashedContact: hashB },
    { userId: 'other', hashedContact: hashA },
  ];
  const result = await caller().social.syncCloudContact({ source: 'apple', hashes: [hashA, hashB, hashA] });
  assert.deepEqual(result, { synced: 2, matched: 2, mutual: 2 });
  assert.deepEqual(deleteWhere, { userId: 'me', hashedContact: { notIn: [hashA, hashB] } });
  assert.deepEqual(createManyData, [
    { userId: 'me', hashedContact: hashA },
    { userId: 'me', hashedContact: hashB },
  ]);
});

test('Suggestions surface mutual hash overlaps, never raw contacts, and skip declined pairs', async () => {
  contactHash.findMany = async ({ where }: any) => where.userId === 'me'
    ? [{ hashedContact: hashA }, { hashedContact: hashB }]
    : [{ userId: 'friend' }, { userId: 'declined-user' }];
  user.findMany = async () => [
    { id: 'friend', name: 'Friend' },
    { id: 'declined-user', name: 'Declined' },
  ];
  socialInvitation.findMany = async () => [
    { fromUserId: 'friend', toUserId: 'me', status: 'pending' },
    { fromUserId: 'me', toUserId: 'declined-user', status: 'declined' },
  ];
  socialCircleMember.findMany = async () => [{ userId: 'friend', circleId: 'circle-1' }];

  const { items } = await caller().social.suggestions();
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { userId: 'friend', name: 'Friend', relationshipStatus: 'invite_received', circleIds: ['circle-1'] });
  for (const item of items) assert.deepEqual(Object.keys(item), ['userId', 'name', 'relationshipStatus', 'circleIds']);
});

test('Suggestions are empty without any synced hashes', async () => {
  contactHash.findMany = async () => [];
  assert.deepEqual(await caller().social.suggestions(), { items: [] });
});

test('Circles list marks the caller role and returns member ids', async () => {
  socialCircle.findMany = async () => [
    { id: 'circle-1', name: 'Close Friends', ownerId: 'me', createdAt: new Date(), members: [{ userId: 'friend' }] },
    { id: 'circle-2', name: 'Crew', ownerId: 'friend', createdAt: new Date(), members: [{ userId: 'me' }, { userId: 'friend' }] },
  ];
  const { groups } = await caller().social.groups.list({ surface: 'network' });
  assert.deepEqual(groups[0], { id: 'circle-1', name: 'Close Friends', ownerUserId: 'me', memberCount: 1, memberIds: ['friend'], role: 'owner' });
  assert.equal(groups[1].role, 'member');
});

test('Circle creation persists the authenticated owner', async () => {
  let created: any;
  socialCircle.create = async ({ data }: any) => {
    created = data;
    return { id: 'circle-1', createdAt: new Date(), ...data };
  };
  const circle = await caller().social.groups.create({ name: 'Close Friends', privacy: 'private', surface: 'network' });
  assert.equal(created.ownerId, 'me');
  assert.deepEqual(circle, { id: 'circle-1', name: 'Close Friends', ownerUserId: 'me', memberCount: 0, memberIds: [], role: 'owner' });
});

test('Circle member mutations are owner-only and fail closed', async () => {
  await assert.rejects(() => caller().social.groups.members.add({ groupId: 'circle-1', userId: 'friend', surface: 'network' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller().social.groups.members.remove({ groupId: 'circle-1', userId: 'friend', surface: 'network' }), { code: 'NOT_FOUND' });

  let circleWhere: any;
  socialCircle.findFirst = async ({ where }: any) => {
    circleWhere = where;
    return { id: 'circle-1' };
  };
  assert.deepEqual(await caller().social.groups.members.add({ groupId: 'circle-1', userId: 'friend', surface: 'network' }), { success: true });
  assert.deepEqual(circleWhere, { id: 'circle-1', ownerId: 'me' });

  user.findUnique = async () => null;
  await assert.rejects(() => caller().social.groups.members.add({ groupId: 'circle-1', userId: 'ghost', surface: 'network' }), { code: 'NOT_FOUND' });

  let removed: any;
  socialCircleMember.deleteMany = async ({ where }: any) => {
    removed = where;
    return { count: 1 };
  };
  assert.deepEqual(await caller().social.groups.members.remove({ groupId: 'circle-1', userId: 'friend', surface: 'network' }), { success: true });
  assert.deepEqual(removed, { circleId: 'circle-1', userId: 'friend' });
});

test('People You Met opt-in requires a confirmed guest of that Party', async () => {
  await assert.rejects(() => caller().social.peopleMet.optIn({ partyId: 'party-1' }), { code: 'NOT_FOUND' });

  party.findFirst = async () => ({ id: 'party-1' });
  partyGuest.findUnique = async () => null;
  await assert.rejects(() => caller().social.peopleMet.optIn({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyGuest.findUnique = async () => ({ status: 'pending', accessGranted: false });
  await assert.rejects(() => caller().social.peopleMet.optIn({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  let optInCreate: any;
  partyEncounterOptIn.upsert = async ({ create }: any) => {
    optInCreate = create;
    return { id: 'opt-1', ...create };
  };
  assert.deepEqual(await caller().social.peopleMet.optIn({ partyId: 'party-1' }), { partyId: 'party-1', optedIn: true });
  assert.deepEqual(optInCreate, { partyId: 'party-1', userId: 'me' });
});

test('People You Met opt-out deletes the row immediately and status reflects it', async () => {
  let deleted: any;
  partyEncounterOptIn.deleteMany = async ({ where }: any) => {
    deleted = where;
    return { count: 1 };
  };
  assert.deepEqual(await caller().social.peopleMet.optOut({ partyId: 'party-1' }), { partyId: 'party-1', optedIn: false });
  assert.deepEqual(deleted, { partyId: 'party-1', userId: 'me' });

  partyEncounterOptIn.findUnique = async () => null;
  assert.deepEqual(await caller().social.peopleMet.status({ partyId: 'party-1' }), { partyId: 'party-1', optedIn: false });
  partyEncounterOptIn.findUnique = async () => ({ id: 'opt-1' });
  assert.deepEqual(await caller().social.peopleMet.status({ partyId: 'party-1' }), { partyId: 'party-1', optedIn: true });
});

test('People You Met list requires an ended Party and mutual opt-in with real attendance', async () => {
  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() + 60_000) });
  await assert.rejects(() => caller().social.peopleMet.list({ partyId: 'party-1' }), { code: 'PRECONDITION_FAILED' });

  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() - 60_000) });
  partyEncounterOptIn.findUnique = async () => null;
  partyGuest.findUnique = async () => ({ status: 'checked-in', accessGranted: true });
  await assert.rejects(() => caller().social.peopleMet.list({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyEncounterOptIn.findUnique = async () => ({ id: 'opt-1' });
  partyGuest.findUnique = async () => ({ status: 'pending', accessGranted: false });
  await assert.rejects(() => caller().social.peopleMet.list({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyGuest.findUnique = async () => ({ status: 'checked-in', accessGranted: true });
  partyEncounterOptIn.findMany = async () => [{ userId: 'friend' }, { userId: 'no-show' }];
  let guestWhere: any;
  partyGuest.findMany = async ({ where }: any) => {
    guestWhere = where;
    return [{ userId: 'friend', user: { id: 'friend', name: 'Friend' } }];
  };
  socialInvitation.findMany = async () => [{ fromUserId: 'me', toUserId: 'friend', status: 'pending' }];

  const result = await caller().social.peopleMet.list({ partyId: 'party-1' });
  assert.deepEqual(result, {
    partyId: 'party-1',
    items: [{ userId: 'friend', name: 'Friend', inviteExists: true, relationshipStatus: 'invite_sent' }],
  });
  assert.deepEqual(guestWhere.status, { in: ['rsvp', 'ticketed', 'approved', 'checked-in'] });
  assert.equal(guestWhere.accessGranted, true);
  for (const item of result.items) assert.deepEqual(Object.keys(item), ['userId', 'name', 'inviteExists', 'relationshipStatus']);
});
