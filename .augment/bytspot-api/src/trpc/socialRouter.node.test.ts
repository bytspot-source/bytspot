import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import { hashEmail, hashPhone, keyContactHash, normalizeEmail, normalizePhone } from '../lib/contactHash';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
// Nobody has blocked anybody unless a test says so.
(db.userBlock as any).findMany = async () => [];
(db.userBlock as any).findFirst = async () => null;
const authenticatedContext: Context = { user: { userId: 'me', email: 'me@bytspot.com' }, clientRateLimitKey: 'test-social-client' };
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const user = db.user as any;
const socialInvitation = db.socialInvitation as any;
const socialCircle = db.socialCircle as any;
const socialCircleMember = db.socialCircleMember as any;
const contactHash = db.contactHash as any;
const userIdentityHash = db.userIdentityHash as any;
const partyEncounterOptIn = db.partyEncounterOptIn as any;
const party = db.party as any;
const partyGuest = db.partyGuest as any;
const prisma = db as any;
const checkIn = db.checkIn as any;
const pointTransaction = db.pointTransaction as any;


/**
 * A contact graph for the mutual-match rule (REA PL2). `book[me]` is what
 * each member synced; `identity[me]` is each member's own identity hashes.
 */
function graph(book: Record<string, string[]>, identity: Record<string, string[]>) {
  contactHash.findMany = async ({ where }: any) => {
    if (typeof where.userId === 'string') return (book[where.userId] ?? []).map((hashedContact) => ({ userId: where.userId, hashedContact }));
    const ids: string[] = where.userId.in;
    const wanted: string[] = where.hashedContact.in;
    return ids.flatMap((id) => (book[id] ?? []).filter((h) => wanted.includes(h)).map((hashedContact) => ({ userId: id, hashedContact })));
  };
  userIdentityHash.findMany = async ({ where }: any) => {
    if (typeof where.userId === 'string') return (identity[where.userId] ?? []).map((hashedIdentity) => ({ userId: where.userId, hashedIdentity }));
    const wanted: string[] = where.hashedIdentity.in;
    return Object.entries(identity).filter(([id]) => id !== where.userId.not)
      .flatMap(([id, hs]) => hs.filter((h) => wanted.includes(h)).map((hashedIdentity) => ({ userId: id, hashedIdentity })));
  };
}

function caller(context = authenticatedContext) {
  return createCaller(context);
}

beforeEach(() => {
  user.findUnique = async () => ({ id: 'friend', name: 'Friend' });
  user.findMany = async () => [];
  socialInvitation.findMany = async () => [];
  socialInvitation.upsert = async ({ create }: any) => ({ id: 'invite-1', status: 'pending', createdAt: new Date('2026-08-01T00:00:00Z'), respondedAt: null, ...create });
  socialInvitation.updateMany = async () => ({ count: 1 });
  socialInvitation.deleteMany = async () => ({ count: 1 });
  socialCircle.findFirst = async () => null;
  socialCircle.findMany = async () => [];
  socialCircle.create = async ({ data }: any) => ({ id: 'circle-1', createdAt: new Date(), ...data });
  socialCircleMember.upsert = async ({ create }: any) => ({ id: 'member-1', ...create });
  socialCircleMember.deleteMany = async () => ({ count: 1 });
  socialCircleMember.findMany = async () => [];
  contactHash.findMany = async () => [];
  contactHash.deleteMany = async () => ({ count: 0 });
  contactHash.createMany = async () => ({ count: 0 });
  userIdentityHash.findMany = async () => [];
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

test('Invite creation is reciprocity-aware across both directions', async () => {
  // Reverse pending: the target already invited the caller — no duplicate row.
  socialInvitation.findMany = async () => [
    { id: 'in-1', fromUserId: 'friend', toUserId: 'me', status: 'pending', createdAt: new Date('2026-08-01T00:00:00Z'), respondedAt: null },
  ];
  await assert.rejects(
    () => caller().social.invites.create({ targetType: 'user', targetValue: 'friend', surface: 'network' }),
    (error: any) => error.code === 'CONFLICT' && error.message === 'This person already invited you. Respond to their invitation instead.',
  );

  // Accepted in either direction: idempotently return the stored row.
  let upsertCalled = false;
  socialInvitation.upsert = async () => {
    upsertCalled = true;
    throw new Error('should not create a new row when an accepted invitation exists');
  };
  socialInvitation.findMany = async () => [
    { id: 'accepted-1', fromUserId: 'friend', toUserId: 'me', status: 'accepted', createdAt: new Date('2026-08-01T00:00:00Z'), respondedAt: new Date('2026-08-02T00:00:00Z') },
  ];
  const accepted = await caller().social.invites.create({ targetType: 'user', targetValue: 'friend', surface: 'network' });
  assert.equal(accepted.id, 'accepted-1');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.direction, 'incoming');
  assert.equal(upsertCalled, false);

  // Reverse declined: the caller may still send their own pending invite.
  socialInvitation.findMany = async () => [
    { id: 'declined-1', fromUserId: 'friend', toUserId: 'me', status: 'declined', createdAt: new Date('2026-08-01T00:00:00Z'), respondedAt: new Date('2026-08-02T00:00:00Z') },
  ];
  socialInvitation.upsert = async ({ create }: any) => ({ id: 'invite-2', status: 'pending', createdAt: new Date('2026-08-05T00:00:00Z'), respondedAt: null, ...create });
  const invite = await caller().social.invites.create({ targetType: 'user', targetValue: 'friend', surface: 'network' });
  assert.equal(invite.id, 'invite-2');
  assert.equal(invite.direction, 'outgoing');
  assert.equal(invite.status, 'pending');

  // Concurrent reciprocal create: the check reads an empty pair, but the
  // DB partial unique index on the unordered pair rejects the write (P2002).
  // The loser must surface the same CONFLICT as a sequential reverse-pending.
  socialInvitation.findMany = async () => [];
  socialInvitation.upsert = async () => {
    const error: any = new Error('unique constraint');
    error.code = 'P2002';
    throw error;
  };
  await assert.rejects(
    () => caller().social.invites.create({ targetType: 'user', targetValue: 'friend', surface: 'network' }),
    (error: any) => error.code === 'CONFLICT' && error.message === 'This person already invited you. Respond to their invitation instead.',
  );
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

test('Only the pending sender can cancel an invitation', async () => {
  let deleteWhere: any;
  socialInvitation.deleteMany = async ({ where }: any) => {
    deleteWhere = where;
    return { count: 1 };
  };
  assert.deepEqual(await caller().social.invites.cancel({ inviteId: 'invite-1', surface: 'network' }), { success: true });
  assert.deepEqual(deleteWhere, { id: 'invite-1', fromUserId: 'me', status: 'pending' });

  socialInvitation.deleteMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().social.invites.cancel({ inviteId: 'invite-1', surface: 'network' }), { code: 'NOT_FOUND' });
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
  const [kA, kB] = [keyContactHash(hashA), keyContactHash(hashB)];
  // friend is in my book (kA) and I am in friend's book; other only overlaps.
  graph({ friend: ['me-id-hash'], other: [kA] }, { me: ['me-id-hash'], friend: [kA] });
  const result = await caller().social.syncCloudContact({ source: 'apple', hashes: [hashA, hashB, hashA] });
  assert.deepEqual(result, { synced: 2, matched: 1, mutual: 1 }, 'only the mutual match is counted');
  void kB;
  // What is stored is keyed with the server-only pepper, never the client hash.
  const [keyedA, keyedB] = [keyContactHash(hashA), keyContactHash(hashB)];
  assert.match(keyedA, /^[a-f0-9]{64}$/);
  assert.notEqual(keyedA, hashA);
  assert.deepEqual(deleteWhere, { userId: 'me', hashedContact: { notIn: [keyedA, keyedB] } });
  assert.deepEqual(createManyData, [
    { userId: 'me', hashedContact: keyedA },
    { userId: 'me', hashedContact: keyedB },
  ]);
});

test('Suggestions surface only mutual matches, never raw contacts, and skip declined pairs', async () => {
  graph(
    { me: ['h-friend', 'h-declined'], friend: ['h-me'], 'declined-user': ['h-me'] },
    { me: ['h-me'], friend: ['h-friend'], 'declined-user': ['h-declined'] },
  );
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

test('REA PL2: contact-book overlap alone never suggests anyone (no who-knows-whom)', async () => {
  // stranger and I share a contact, but neither has the other.
  graph({ me: ['h-shared'], stranger: ['h-shared'] }, { me: ['h-me'], stranger: ['h-stranger'] });
  user.findMany = async () => { throw new Error('no candidate should be looked up'); };
  assert.deepEqual(await caller().social.suggestions(), { items: [] });
});

test('A block either way hides the member from suggestions and refuses invites and follows', async () => {
  graph(
    { me: ['h-friend', 'h-blocked'], friend: ['h-me'], 'blocked-user': ['h-me'] },
    { me: ['h-me'], friend: ['h-friend'], 'blocked-user': ['h-blocked'] },
  );
  let asked: string[] = [];
  user.findMany = async ({ where }: any) => {
    asked = where.id.in;
    assert.equal(where.suspendedAt, null, 'suspended accounts are never suggested');
    return [{ id: 'friend', name: 'Friend' }];
  };
  (db.userBlock as any).findMany = async () => [{ blockerId: 'blocked-user', blockedId: 'me' }];
  (db.userBlock as any).findFirst = async () => ({ id: 'block-1' });
  try {
    await caller().social.suggestions();
    assert.deepEqual(asked, ['friend']);
    await assert.rejects(() => caller().social.invites.create({ targetType: 'user', targetValue: 'blocked-user' }), { code: 'NOT_FOUND' });
    await assert.rejects(() => caller().social.follow({ userId: 'blocked-user' }), { code: 'NOT_FOUND' });
  } finally {
    (db.userBlock as any).findMany = async () => [];
    (db.userBlock as any).findFirst = async () => null;
  }
});

test('REA PL2: a one-sided identity match is not a suggestion, so an uploaded phone hash cannot be turned into a name', async () => {
  // The caller uploaded the friend's phone hash; the friend never had the caller.
  graph({ me: ['h-friend'] }, { me: ['h-me'], friend: ['h-friend'] });
  user.findMany = async () => { throw new Error('no candidate should be looked up'); };
  assert.deepEqual(await caller().social.suggestions(), { items: [] });
});

test('Contact sync counts only mutual matches in matched/mutual', async () => {
  const kA = keyContactHash(hashA);
  graph({ friend: [] }, { me: ['h-me'], friend: [kA] });
  assert.deepEqual(await caller().social.syncCloudContact({ source: 'apple', hashes: [hashA, hashB] }), { synced: 2, matched: 0, mutual: 0 });
});

test('Contact hashing pins the iOS BytspotContactHasher contract (fixed vectors, dev salt)', () => {
  // Vectors computed with salt "dev-contact-salt-change-me" — the iOS
  // BytspotContactHasher must produce identical digests for these inputs.
  assert.equal(normalizeEmail('  Friend@Bytspot.COM '), 'friend@bytspot.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizePhone('(415) 555-1212'), '14155551212');
  assert.equal(normalizePhone('+1 415 555 1212'), '14155551212');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(hashEmail('  Friend@Bytspot.COM '), '83dede3460ef7b64930a992131c4280b6db3086c6c6382420cbd3dac0d4a442e');
  assert.equal(hashPhone('(415) 555-1212'), 'af267c845c1211f1a3bf6c8d9a1a423856f498190c4fc980bd1899176524e900');
  assert.equal(hashEmail(''), null);
  assert.equal(hashPhone(''), null);
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

test('Circle deletion is owner-only and cascades via a single delete', async () => {
  await assert.rejects(() => caller().social.groups.delete({ groupId: 'circle-1', surface: 'network' }), { code: 'NOT_FOUND' });

  let circleWhere: any;
  let deletedWhere: any;
  socialCircle.findFirst = async ({ where }: any) => {
    circleWhere = where;
    return { id: 'circle-1' };
  };
  socialCircle.delete = async ({ where }: any) => {
    deletedWhere = where;
    return { id: 'circle-1' };
  };
  assert.deepEqual(await caller().social.groups.delete({ groupId: 'circle-1', surface: 'network' }), { success: true });
  assert.deepEqual(circleWhere, { id: 'circle-1', ownerId: 'me' });
  assert.deepEqual(deletedWhere, { id: 'circle-1' });
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

const HOUR_MS = 60 * 60 * 1000;

test('People You Met list only opens after the Party has ended', async () => {
  partyEncounterOptIn.findUnique = async () => ({ id: 'opt-1' });
  partyGuest.findUnique = async () => ({ status: 'checked-in', accessGranted: true });

  // No endsAt: mid-window (started 1h ago) is still closed…
  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() - 1 * HOUR_MS), endsAt: null });
  await assert.rejects(
    () => caller().social.peopleMet.list({ partyId: 'party-1' }),
    (error: any) => error.code === 'PRECONDITION_FAILED' && error.message === 'People You Met opens after the Party has ended.',
  );

  // …but the 6-hour fallback window has elapsed after 7 hours.
  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() - 7 * HOUR_MS), endsAt: null });
  const afterFallback = await caller().social.peopleMet.list({ partyId: 'party-1' });
  assert.equal(afterFallback.partyId, 'party-1');

  // Explicit endsAt in the future keeps the surface closed even long after start.
  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() - 10 * HOUR_MS), endsAt: new Date(Date.now() + 60_000) });
  await assert.rejects(() => caller().social.peopleMet.list({ partyId: 'party-1' }), { code: 'PRECONDITION_FAILED' });

  // Explicit endsAt in the past opens it.
  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() - 2 * HOUR_MS), endsAt: new Date(Date.now() - 60_000) });
  const afterEnd = await caller().social.peopleMet.list({ partyId: 'party-1' });
  assert.equal(afterEnd.partyId, 'party-1');
});

test('People You Met list requires mutual opt-in and door check-in on both sides', async () => {
  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() - 7 * HOUR_MS), endsAt: null });

  partyEncounterOptIn.findUnique = async () => null;
  partyGuest.findUnique = async () => ({ status: 'checked-in', accessGranted: true });
  await assert.rejects(() => caller().social.peopleMet.list({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  partyEncounterOptIn.findUnique = async () => ({ id: 'opt-1' });
  partyGuest.findUnique = async () => ({ status: 'pending', accessGranted: false });
  await assert.rejects(() => caller().social.peopleMet.list({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  // Opted-in caller with rsvp status but no door check-in cannot see anyone.
  partyGuest.findUnique = async () => ({ status: 'rsvp', accessGranted: true });
  await assert.rejects(
    () => caller().social.peopleMet.list({ partyId: 'party-1' }),
    (error: any) => error.code === 'PRECONDITION_FAILED' && /checked in/.test(error.message),
  );

  partyGuest.findUnique = async () => ({ status: 'checked-in', accessGranted: true });
  partyEncounterOptIn.findMany = async () => [{ userId: 'friend' }, { userId: 'rsvp-only' }, { userId: 'no-show' }];
  let guestWhere: any;
  partyGuest.findMany = async ({ where }: any) => {
    guestWhere = where;
    // The rsvp-only guest is excluded by the checked-in filter.
    return [{ userId: 'friend', user: { id: 'friend', name: 'Friend' } }];
  };
  socialInvitation.findMany = async () => [{ fromUserId: 'me', toUserId: 'friend', status: 'pending' }];

  const result = await caller().social.peopleMet.list({ partyId: 'party-1' });
  assert.deepEqual(result, {
    partyId: 'party-1',
    items: [{ userId: 'friend', name: 'Friend', inviteStatus: 'pending', relationshipStatus: 'invite_sent' }],
  });
  assert.equal(guestWhere.status, 'checked-in');
  assert.equal(guestWhere.accessGranted, true);
  assert.ok(!result.items.some((item) => item.userId === 'rsvp-only'));
});

test('People You Met items match the iOS NativePeopleMetPerson shape', async () => {
  party.findFirst = async () => ({ id: 'party-1', startsAt: new Date(Date.now() - 7 * HOUR_MS), endsAt: null });
  partyEncounterOptIn.findUnique = async () => ({ id: 'opt-1' });
  partyGuest.findUnique = async () => ({ status: 'checked-in', accessGranted: true });
  partyEncounterOptIn.findMany = async () => [{ userId: 'pending-out' }, { userId: 'accepted-in' }, { userId: 'declined-out' }, { userId: 'stranger' }];
  partyGuest.findMany = async () => [
    { userId: 'pending-out', user: { id: 'pending-out', name: 'Pending Out' } },
    { userId: 'accepted-in', user: { id: 'accepted-in', name: 'Accepted In' } },
    { userId: 'declined-out', user: { id: 'declined-out', name: 'Declined Out' } },
    { userId: 'stranger', user: { id: 'stranger', name: null } },
  ];
  socialInvitation.findMany = async () => [
    { fromUserId: 'me', toUserId: 'pending-out', status: 'pending' },
    { fromUserId: 'accepted-in', toUserId: 'me', status: 'accepted' },
    { fromUserId: 'me', toUserId: 'declined-out', status: 'declined' },
  ];

  const { items } = await caller().social.peopleMet.list({ partyId: 'party-1' });
  const byId = new Map(items.map((item: any) => [item.userId, item]));
  // inviteStatus is exactly 'pending' | 'accepted' | 'declined', lowercased.
  assert.equal(byId.get('pending-out').inviteStatus, 'pending');
  assert.equal(byId.get('accepted-in').inviteStatus, 'accepted');
  assert.equal(byId.get('declined-out').inviteStatus, 'declined');
  // No invitation in either direction → the key is omitted (nil → can invite).
  assert.ok(!('inviteStatus' in byId.get('stranger')));
  assert.equal(byId.get('stranger').name, 'Bytspot member');
  for (const item of items) {
    assert.equal(typeof item.userId, 'string');
    assert.equal(typeof item.name, 'string');
    if ('inviteStatus' in item) assert.ok(['pending', 'accepted', 'declined'].includes(item.inviteStatus ?? ''));
  }
});

test('Venue check-ins and the leaderboard are members-only and name nobody', async () => {
  const anonymous = createCaller({ user: null, clientRateLimitKey: 'test-social-anon' });
  await assert.rejects(() => anonymous.social.venueCheckins({ venueId: 'venue-1' }), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => anonymous.social.leaderboard({}), { code: 'UNAUTHORIZED' });

  // Even to a member, a venue's recent activity is a count and a crowd level.
  // Names and ids are what turned 40 requests into a movement profile.
  checkIn.findMany = async () => [
    { id: 'c1', crowdLevel: 2, crowdLabel: 'Active', createdAt: new Date('2026-08-24T20:00:00Z') },
  ];
  const visits = await caller().social.venueCheckins({ venueId: 'venue-1' });
  assert.equal(visits.count, 1);
  assert.deepEqual(Object.keys(visits.items[0]).sort(), ['crowdLabel', 'crowdLevel', 'id', 'timestamp']);

  pointTransaction.groupBy = async () => [{ userId: 'user-1', _sum: { amount: 120 } }];
  user.findMany = async () => [{ id: 'user-1', name: 'Ada' }];
  const ranks = await caller().social.leaderboard({});
  assert.deepEqual(ranks, [{ rank: 1, name: 'Ada', points: 120 }]);
});

test('Rows stored before the pepper are rekeyed to exactly what a fresh sync would write', async () => {
  const { rekeyStoredContactHashes } = await import('../services/userIdentityHashes');
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const contactRows = [{ id: 'c1', userId: 'me', hashedContact: hashA, createdAt }];
  const identityRows = [{ id: 'i1', userId: 'friend', hashedIdentity: hashEmail('friend@bytspot.com')!, kind: 'email', createdAt }];
  const calls: string[] = [];
  const written: Record<string, any[]> = { contact: [], identity: [] };
  const table = (name: 'contact' | 'identity', rows: any[]) => ({
    findMany: async ({ where }: any) => { assert.deepEqual(where, { keyed: false }); return rows.splice(0); },
    deleteMany: async ({ where }: any) => { calls.push(`${name}:delete:${where.id.in.join(',')}`); return { count: where.id.in.length }; },
    createMany: async ({ data, skipDuplicates }: any) => { assert.equal(skipDuplicates, true); written[name].push(...data); return { count: data.length }; },
  });
  const database: any = { contactHash: table('contact', contactRows), userIdentityHash: table('identity', identityRows), $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops) };

  const done = await rekeyStoredContactHashes(500, database);
  assert.deepEqual(done, { contacts: 1, identities: 1 });
  assert.deepEqual(calls, ['contact:delete:c1', 'identity:delete:i1']);
  assert.deepEqual(written.contact, [{ userId: 'me', hashedContact: keyContactHash(hashA), createdAt, keyed: true }]);
  // The rekeyed identity matches a newly synced contact for the same email.
  assert.deepEqual(written.identity, [{ userId: 'friend', hashedIdentity: keyContactHash(hashEmail('friend@bytspot.com')!), kind: 'email', createdAt, keyed: true }]);
});
