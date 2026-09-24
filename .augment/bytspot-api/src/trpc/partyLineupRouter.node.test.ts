import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { partyLineupRouter } from './partyLineupRouter';

const callerFactory = createCallerFactory(partyLineupRouter);
const caller = (userId: string | null = 'host') => callerFactory({ user: userId ? { userId, email: 'unused@test.invalid' } : null, clientRateLimitKey: 'lineup-tests' });
const prisma = db as any;
const table = db.partyPerformer as any;
const party = db.party as any;
const user = db.user as any;
let updates: any[];
let creates: any[];
let queries: any[];
let transactionOptions: any;
const live = { id: 'party', status: 'published', hostUserId: 'host', closedAt: null, startsAt: new Date(Date.now() + 3600000), endsAt: null, shareLinkExpiresAt: null };

beforeEach(() => {
  resetLocalRateLimitForTests(); updates = []; creates = []; queries = [];
  prisma.$transaction = async (fn: any, options: any) => { transactionOptions = options; return fn(db); };
  user.findFirst = async ({ where }: any) => ({ id: where.id });
  party.findFirst = async ({ where }: any) => where.hostUserId && where.hostUserId !== 'host' ? null : live;
  (db.partyGuest as any).findUnique = async () => null;
  table.findMany = async (args: any) => { queries.push(args); return []; };
  table.findFirst = async () => null;
  table.count = async () => 0;
  table.create = async ({ data }: any) => { creates.push(data); return { id: 'entry', ...data }; };
  table.updateMany = async (args: any) => { updates.push(args); return { count: 1 }; };
});

const invitation = { partyId: 'party', invitedUserId: 'performer', displayName: 'DJ North', role: 'dj' as const };
test('all private operations reject anonymous callers and non-host host operations', async () => {
  await assert.rejects(() => caller(null).invite(invitation), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => caller(null).myInvitations(), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => caller('stranger').invite(invitation), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller('stranger').hostList({ partyId: 'party' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller('stranger').remove({ partyId: 'party', id: 'entry', version: 0 }), { code: 'NOT_FOUND' });
});

test('unknown and existing target IDs have identical response, no target lookup or delivery claim', async () => {
  const lookedUp: string[] = [];
  user.findFirst = async ({ where }: any) => { lookedUp.push(where.id); return { id: where.id }; };
  assert.deepEqual(await caller().invite(invitation), { status: 'recorded' });
  assert.deepEqual(await caller().invite({ ...invitation, invitedUserId: 'not-an-account' }), { status: 'recorded' });
  assert.deepEqual(lookedUp, ['host', 'host']);
  assert.deepEqual(creates[0], invitation);
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
});

test('organizers cannot inject payment destinations and credit changes require a new invitation', async () => {
  await assert.rejects(() => caller().invite({ ...invitation, tips: [{ provider: 'venmo', handle: 'hosts' }] } as any), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller('performer').confirm({ id: 'entry', version: 0, consent: true, tips: [], displayName: 'Swapped credit' } as any), { code: 'BAD_REQUEST' });
  assert.equal(creates.length, 0);
});

test('acceptance binds only the authenticated invited account, publishes normalized performer handles', async () => {
  await caller('performer').confirm({ id: 'entry', version: 0, consent: true, tips: [{ provider: 'cash-app', handle: '$DJ42' }] });
  assert.equal(updates[0].where.invitedUserId, 'performer');
  assert.deepEqual(updates[0].where.status, { in: ['pending', 'accepted'] });
  assert.equal(updates[0].where.version, 0);
  assert.equal(updates[0].data.confirmedUserId, 'performer');
  assert.deepEqual(updates[0].data.tipHandles, [{ provider: 'cash-app', handle: 'DJ42' }]);
  assert.equal(updates[0].where.party.status, 'published');
  await assert.rejects(() => caller('performer').confirm({ id: 'entry', version: 1, consent: false, tips: [] } as any), { code: 'BAD_REQUEST' });
});

test('wrong account, revoked entry and stale updates cannot resurrect consent', async () => {
  table.updateMany = async ({ where }: any) => {
    assert.equal(where.invitedUserId, 'attacker');
    return { count: 0 };
  };
  await assert.rejects(() => caller('attacker').confirm({ id: 'entry', version: 0, consent: true, tips: [] }), { code: 'CONFLICT' });
  table.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller('performer').confirm({ id: 'entry', version: 0, consent: true, tips: [] }), { code: 'CONFLICT' });
});

test('soft-deleted accounts fail closed even without Redis revocation', async () => {
  user.findFirst = async () => null;
  await assert.rejects(() => caller('performer').confirm({ id: 'entry', version: 0, consent: true, tips: [] }), { code: 'UNAUTHORIZED' });
  assert.equal(updates.length, 0);
});

test('decline, performer revocation and host removal clear all published payment information', async () => {
  table.findFirst = async () => ({ status: 'pending' });
  assert.deepEqual(await caller('performer').withdraw({ id: 'entry', version: 0 }), { status: 'declined' });
  table.findFirst = async () => ({ status: 'accepted' });
  assert.deepEqual(await caller('performer').withdraw({ id: 'entry', version: 1 }), { status: 'withdrawn' });
  await caller().remove({ partyId: 'party', id: 'entry', version: 2 });
  for (const update of updates) {
    assert.deepEqual(update.data.tipHandles, []);
    assert.equal(update.data.confirmedAt, null);
    assert.deepEqual(update.data.version, { increment: 1 });
  }
});

test('public projection includes accepted active accounts only and has no account contact fields', async () => {
  table.findMany = async (args: any) => {
    assert.equal(args.where.status, 'accepted');
    assert.deepEqual(args.where.confirmedUser, { deletedAt: null });
    assert.deepEqual(Object.keys(args.select).sort(), ['displayName', 'id', 'role', 'tipHandles', 'version']);
    return [{ id: 'entry', displayName: 'DJ North', role: 'dj', version: 1, tipHandles: [] }];
  };
  assert.deepEqual(await caller(null).list({ partyId: 'party' }), { entries: [{ id: 'entry', displayName: 'DJ North', role: 'dj', version: 1, tips: [] }] });
});

test('expired/closed links reject strangers but retain host and confirmed guest exceptions', async () => {
  party.findFirst = async () => ({ ...live, closedAt: new Date(), shareLinkExpiresAt: new Date(0) });
  await assert.rejects(() => caller(null).list({ partyId: 'party' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller('performer').list({ partyId: 'party' }), { code: 'NOT_FOUND' });
  await caller('host').list({ partyId: 'party' });
  (db.partyGuest as any).findUnique = async () => ({ accessGranted: true });
  await caller('guest').list({ partyId: 'party' });
  user.findFirst = async () => null;
  await assert.rejects(() => caller('guest').list({ partyId: 'party' }), { code: 'NOT_FOUND' });
});

test('tip handoff rechecks current consent/version and canonicalizes its destination', async () => {
  const input = { partyId: 'party', id: 'entry', version: 1, provider: 'venmo' as const };
  await assert.rejects(() => caller(null).tip(input), { code: 'NOT_FOUND' });
  table.findFirst = async ({ where }: any) => {
    assert.equal(where.version, 1); assert.equal(where.status, 'accepted');
    return { id: 'entry', version: 1, displayName: 'DJ North', tipHandles: [{ provider: 'venmo', handle: 'DJ_42' }] };
  };
  assert.deepEqual(await caller(null).tip(input), { id: 'entry', version: 1, displayName: 'DJ North', provider: 'venmo', handle: 'DJ_42', url: 'https://venmo.com/DJ_42' });
});

test('draft or missing parties disclose no public lineup and duplicate proposals do not reset consent', async () => {
  party.findFirst = async () => ({ ...live, status: 'draft' });
  await assert.rejects(() => caller('host').list({ partyId: 'party' }), { code: 'NOT_FOUND' });
  party.findFirst = async () => null;
  await assert.rejects(() => caller(null).list({ partyId: 'party' }), { code: 'NOT_FOUND' });
  party.findFirst = async () => live;
  table.findFirst = async () => ({ id: 'existing' });
  assert.deepEqual(await caller().invite({ ...invitation, displayName: 'Changed without consent' }), { status: 'recorded' });
  assert.equal(creates.length, 0);
  assert.equal(updates.length, 0);
});

test('my invitations are scoped to the current account and published parties; active caps and races fail safely', async () => {
  await caller('performer').myInvitations();
  assert.equal(queries[0].where.invitedUserId, 'performer');
  assert.equal(queries[0].where.party.status, 'published');
  table.count = async () => 20;
  await assert.rejects(() => caller().invite(invitation), { code: 'BAD_REQUEST' });
  prisma.$transaction = async () => { throw { code: 'P2034' }; };
  await assert.rejects(() => caller().invite(invitation), { code: 'CONFLICT' });
});
