import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { partySessionAuthoringRouter } from './partySessionAuthoringRouter';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import type { Context } from './context';

const party = db.party as any;
const seat = db.vendorSeat as any;
const session = db.partySession as any;
const checkout = db.partyCheckout as any;
const claim = db.partySessionClaim as any;
const prisma = db as any;
const createCaller = createCallerFactory(partySessionAuthoringRouter);
const context: Context = { user: { userId: 'host', email: 'host@example.test' }, clientRateLimitKey: 'authoring-tests' };
const caller = () => createCaller(context);
const scope = { partyId: 'party', sellerId: 'seller' };
const draft = {
  name: 'Front table', kind: 'table' as const,
  startsAt: '2030-10-10T20:00:00Z', endsAt: '2030-10-11T02:00:00Z',
  bottleCount: 2, bottleTerms: 'included' as const, priceCents: 12345, quantity: 3,
};
let seats: any[];
let writes: any[];
let transactionOptions: any;

beforeEach(() => {
  resetLocalRateLimitForTests();
  writes = [];
  transactionOptions = undefined;
  seats = [{
    sellerId: 'seller', userId: 'host', role: 'owner', state: 'ACTIVE',
    seller: {
      id: 'seller', state: 'ACTIVE', legalName: 'Test seller', contactEmail: 'seller@example.test',
      payoutStatus: 'active', payoutReference: 'test-reference',
      locations: [{ state: 'ACTIVE', kind: 'fixed', address: 'Test address', lat: 33.7, lng: -84.3 }],
    },
  }];
  (db.user as any).findUnique = async () => ({ id: 'host' });
  party.findFirst = async ({ where }: any) => where.hostUserId && where.hostUserId !== 'host' ? null : { id: 'party', hostUserId: 'host' };
  seat.findMany = async ({ where }: any) => seats.filter((row) => row.userId === where.userId && row.state === where.state);
  session.findMany = async () => [];
  session.findFirst = async ({ where }: any) => where.id === 'session' && (!where.partyId || where.partyId === 'party') && where.sellerId === 'seller'
    ? { id: 'session', partyId: 'party', committed: 0 } : null;
  session.create = async ({ data }: any) => { writes.push(data); return { id: 'session', committed: 0, ...data }; };
  session.updateMany = async (input: any) => { writes.push(input); return { count: 1 }; };
  checkout.count = async () => 0;
  claim.count = async () => 0;
  prisma.$transaction = async (callback: any, options: any) => {
    transactionOptions = options;
    return callback({ partySession: session, partyCheckout: checkout, partySessionClaim: claim });
  };
});

test('all procedures require a first-party authenticated session', async () => {
  const anonymous = createCaller({ ...context, user: null });
  for (const call of [() => anonymous.access(scope), () => anonymous.list(scope), () => anonymous.upsert({ ...scope, session: draft }), () => anonymous.withdraw({ ...scope, sessionId: 'session' })]) {
    await assert.rejects(call, { code: 'UNAUTHORIZED' });
  }
  assert.equal(writes.length, 0);
});

test('outsiders and missing/cancelled parties are NOT_FOUND before seller lookup', async () => {
  party.findFirst = async ({ where }: any) => {
    assert.equal(where.hostUserId, 'host');
    assert.deepEqual(where.status, { not: 'cancelled' });
    return null;
  };
  seat.findMany = async () => { throw new Error('must not reveal seats'); };
  for (const partyId of ['another-host', 'missing', 'cancelled']) {
    await assert.rejects(() => caller().access({ partyId }), { code: 'NOT_FOUND', message: 'Party not found.' });
    await assert.rejects(() => caller().list({ partyId }), { code: 'NOT_FOUND' });
    await assert.rejects(() => caller().upsert({ partyId, session: draft }), { code: 'NOT_FOUND' });
    await assert.rejects(() => caller().withdraw({ partyId, sessionId: 'session' }), { code: 'NOT_FOUND' });
  }
});

test('host without ACTIVE seat gets actionable setup reason and no write', async () => {
  for (const state of ['INVITED', 'SUSPENDED', 'REVOKED']) {
    seats[0].state = state;
    const access = await caller().access({ partyId: 'party' });
    assert.deepEqual(access.sellers, []);
    assert.match(access.reason!, /active seller seat/);
    await assert.rejects(() => caller().upsert({ ...scope, session: draft }), { code: 'FORBIDDEN' });
  }
  assert.equal(writes.length, 0);
});

test('role and seller state both constrain SELL; assigned service provider cannot author', async () => {
  for (const role of ['staff', 'door', 'serviceProvider', 'unknown']) {
    seats[0].role = role;
    await assert.rejects(() => caller().list(scope), { code: 'FORBIDDEN' });
  }
  seats[0].role = 'owner';
  for (const state of ['DRAFT', 'PENDING', 'SUSPENDED', 'CLOSED']) {
    seats[0].seller.state = state;
    await assert.rejects(() => caller().upsert({ ...scope, session: draft }), { code: 'FORBIDDEN' });
    await assert.rejects(() => caller().withdraw({ ...scope, sessionId: 'session' }), { code: 'FORBIDDEN' });
  }
  assert.equal(writes.length, 0);
});

test('lapsed payout requirements fail closed without provisioning an account', async () => {
  seats[0].seller.payoutStatus = 'restricted';
  const access = await caller().access({ partyId: 'party' });
  assert.equal(access.sellers[0].canAuthor, false);
  assert.match(access.sellers[0].reason!, /Payout account/);
  await assert.rejects(() => caller().upsert({ ...scope, session: draft }), { code: 'FORBIDDEN' });
  seats[0].seller.payoutStatus = 'active';
  seats[0].seller.payoutReference = null;
  await assert.rejects(() => caller().upsert({ ...scope, session: draft }), { code: 'FORBIDDEN' });
  assert.equal(writes.length, 0);
});

test('multiple businesses require explicit selection and foreign seller IDs never grant authority', async () => {
  seats.push({ ...seats[0], sellerId: 'other-owned', seller: { ...seats[0].seller, id: 'other-owned' } });
  await assert.rejects(() => caller().list({ partyId: 'party' }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller().upsert({ partyId: 'party', sellerId: 'foreign', session: draft }), { code: 'NOT_FOUND' });
  assert.deepEqual(await caller().list(scope), { sessions: [] });
});

test('authorized owner/manager create uses the real service and exact nullable defaults', async () => {
  for (const role of ['owner', 'manager']) {
    seats[0].role = role;
    const result = await caller().upsert({ ...scope, session: draft });
    assert.equal(result.priceCents, 12345);
    assert.equal(result.startsAt, '2030-10-10T20:00:00.000Z');
    assert.equal(result.venueName, null);
    assert.equal(result.lat, null);
    assert.equal(result.lng, null);
    assert.equal(result.requiredMembershipTier, null);
    assert.equal(writes.at(-1).sellerId, 'seller');
    assert.equal(writes.at(-1).partyId, 'party');
  }
});

test('position collision still uses the existing service retry rather than duplicating authoring logic', async () => {
  let attempts = 0;
  session.create = async ({ data }: any) => {
    attempts += 1;
    if (attempts === 1) throw { code: 'P2002', meta: { target: ['party_id', 'position'] } };
    writes.push(data);
    return { id: 'session', committed: 0, ...data };
  };
  session.findFirst = async () => ({ position: 7 });
  const result = await caller().upsert({ ...scope, session: draft });
  assert.equal(attempts, 2);
  assert.equal(result.position, 8);
  assert.equal(writes.length, 1);
});

test('list is seller scoped and excludes retired inventory', async () => {
  session.findMany = async ({ where }: any) => {
    assert.deepEqual(where, { partyId: 'party', sellerId: 'seller', withdrawnAt: null });
    return [];
  };
  assert.deepEqual(await caller().list(scope), { sessions: [] });
});

test('integer money, unsupported free, bounds and edit attempts are rejected', async () => {
  for (const priceCents of [0, -1, 0.5, 10_000_001, '1200']) {
    await assert.rejects(() => caller().upsert({ ...scope, session: { ...draft, priceCents } as any }), { code: 'BAD_REQUEST' });
  }
  await assert.rejects(() => caller().upsert({ ...scope, sessionId: 'session', session: draft }), { code: 'BAD_REQUEST', message: /Editing an existing session/ });
  assert.equal(writes.length, 0);
});

test('service refusals retain actionable validation and no party-hours constraint is added', async () => {
  await assert.rejects(() => caller().upsert({ ...scope, session: { ...draft, endsAt: draft.startsAt } }), { code: 'BAD_REQUEST', message: /end after/ });
  await assert.rejects(() => caller().upsert({ ...scope, session: { ...draft, bottleCount: 0, bottleTerms: 'minimum' } }), { code: 'BAD_REQUEST', message: /zero bottles/ });
  session.findMany = async () => [{ name: ' FRONT TABLE ', position: 0, withdrawnAt: null }];
  await assert.rejects(() => caller().upsert({ ...scope, session: draft }), { code: 'BAD_REQUEST', message: /share a name/ });
});

test('withdrawal binds party AND seller before delegating; cross-party session is hidden', async () => {
  session.findFirst = async ({ where }: any) => {
    assert.deepEqual(where, { id: 'other-party-session', partyId: 'party', sellerId: 'seller', withdrawnAt: null });
    return null;
  };
  await assert.rejects(() => caller().withdraw({ ...scope, sessionId: 'other-party-session' }), { code: 'NOT_FOUND' });
  assert.equal(writes.length, 0);
});

test('withdraw uses existing serializable retirement and preserves historical purchases', async () => {
  assert.deepEqual(await caller().withdraw({ ...scope, sessionId: 'session' }), { withdrawn: true });
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
  assert.equal(writes[0].where.committed, 0);
  assert.ok(writes[0].data.withdrawnAt instanceof Date);
});

test('held claims, live checkout and serialization races remain CONFLICT', async () => {
  claim.count = async () => 1;
  await assert.rejects(() => caller().withdraw({ ...scope, sessionId: 'session' }), { code: 'CONFLICT' });
  claim.count = async () => 0;
  checkout.count = async () => 1;
  await assert.rejects(() => caller().withdraw({ ...scope, sessionId: 'session' }), { code: 'CONFLICT' });
  checkout.count = async () => 0;
  prisma.$transaction = async () => { throw { code: 'P2034' }; };
  await assert.rejects(() => caller().withdraw({ ...scope, sessionId: 'session' }), { code: 'CONFLICT' });
  assert.equal(writes.length, 0);
});
