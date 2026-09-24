import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { createCallerFactory, resetLocalRateLimitForTests, router } from './trpc';
import { partyCommerceRouter } from './partyCommerceRouter';

// Mount exactly as production integration will, without modifying appRouter.
const caller = createCallerFactory(router({ events: router({ commerce: partyCommerceRouter }) }));
const signedIn = (userId = 'commerce-a') => caller({ user: { userId, email: 'commerce@example.test' }, clientRateLimitKey: 'commerce-test' });
const guests = db.partyGuest as any;
const checkouts = db.partyCheckout as any;
const claims = db.partySessionClaim as any;
const originals = [guests.findMany, checkouts.findMany, claims.findMany];
const date = new Date('2026-01-01T00:00:00Z');
const party = { id: 'party', title: 'The night', startsAt: date, endsAt: null, closedAt: date };
const session = { id: 'table', name: 'Front table', startsAt: date, endsAt: date, bottleCount: 2, bottleTerms: 'minimum', withdrawnAt: date };

beforeEach(() => {
  resetLocalRateLimitForTests();
  guests.findMany = async () => [];
  checkouts.findMany = async () => [];
  claims.findMany = async () => [];
});
afterEach(() => {
  [guests.findMany, checkouts.findMany, claims.findMany] = originals;
});

test('commerce requires authentication and refuses caller-supplied identity', async () => {
  let read = false;
  guests.findMany = async () => { read = true; return []; };
  await assert.rejects(() => caller({ user: null, clientRateLimitKey: 'anonymous' }).events.commerce.mine(), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => signedIn().events.commerce.mine({ userId: 'victim' } as any), { code: 'BAD_REQUEST' });
  assert.equal(read, false);
});

test('confirmed passes include upcoming and past closed rooms with bounded account-scoped pages', async () => {
  let query: any;
  guests.findMany = async (input: any) => {
    query = input;
    return [
      { id: 'z', status: 'rsvp', accessGranted: true, ticketTierName: null, checkedInAt: null, party },
      { id: 'y', status: 'ticketed', accessGranted: true, ticketTierName: 'Door', checkedInAt: null, party: { ...party, startsAt: new Date('2099-01-01'), closedAt: null } },
      { id: 'x', status: 'rsvp', accessGranted: true, ticketTierName: null, checkedInAt: null, party },
    ];
  };
  const result = await signedIn().events.commerce.mine({ kind: 'passes', limit: 2 });
  assert.deepEqual(query.where, { userId: 'commerce-a', accessGranted: true, party: { status: 'published' } });
  assert.equal(query.take, 3);
  assert.equal(query.select.credential, undefined);
  assert.equal(query.select.party.select.venueName, undefined);
  assert.equal(result.nextCursor, 'y');
  assert.equal(result.passes?.length, 2);
  assert.equal(result.passes?.[0].party.isPast, true);
  assert.equal(result.passes?.[0].party.closed, true);
  assert.equal(result.passes?.[1].party.isPast, false);
  await signedIn('commerce-b').events.commerce.mine({ kind: 'passes', cursor: 'foreign-cursor' });
  assert.equal(query.where.userId, 'commerce-b');
  assert.deepEqual(query.where.id, { lt: 'foreign-cursor' });
});

test('purchases retain pending, paid, expired and refund states without promoting any to admission', async () => {
  let query: any;
  const statuses = ['creating', 'pending', 'completed', 'expired', 'refund-required', 'refunded'];
  checkouts.findMany = async (input: any) => {
    query = input;
    return statuses.map((status, i) => ({ id: `purchase-${i}`, status, idempotencyKey: '00000000-0000-4000-8000-000000000001', ticketTierName: null,
      amountCents: 5000, sessionAmountCents: 5000, currency: 'usd', reservationExpiresAt: date,
      completedAt: status === 'completed' ? date : null, createdAt: date, party, session }));
  };
  const result = await signedIn().events.commerce.mine({ kind: 'purchases' });
  assert.deepEqual(query.where, { userId: 'commerce-a' });
  for (const field of ['checkoutUrl', 'stripeSessionId', 'hostNetCents', 'platformFeeCents']) {
    assert.equal(query.select[field], undefined);
  }
  assert.deepEqual(result.purchases?.map((p) => p.status), statuses);
  assert.equal(result.purchases?.[1].reservationElapsed, true);
  assert.equal(result.purchases?.[2].session?.bottleTerms, 'minimum');
  assert.equal(result.purchases?.[2].session?.withdrawn, true);
  assert.equal('accessGranted' in (result.purchases?.[2] ?? {}), false);
  assert.equal(result.nextCursor, null);
});

test('claims remain independently retrievable including released and withdrawn sessions', async () => {
  let query: any;
  claims.findMany = async (input: any) => {
    query = input;
    return ['held', 'released'].map((state, i) => ({ id: `claim-${i}`, state, createdAt: date, session: { ...session, party } }));
  };
  const result = await signedIn('commerce-b').events.commerce.mine({ kind: 'claims', cursor: 'z', limit: 1 });
  assert.deepEqual(query.where, { userId: 'commerce-b', id: { lt: 'z' } });
  assert.equal(result.claims?.[0].state, 'held');
  assert.equal(result.claims?.[0].session.withdrawn, true);
  assert.equal(result.nextCursor, 'claim-0');
  const all = await signedIn('commerce-b').events.commerce.mine({ kind: 'claims' });
  assert.deepEqual(all.claims?.map((claim) => claim.state), ['held', 'released']);
});

test('party-specific receipt retrieval cannot cross accounts or broaden the query', async () => {
  let query: any;
  checkouts.findMany = async (input: any) => { query = input; return []; };
  const result = await signedIn('commerce-b').events.commerce.mine({ kind: 'purchases', partyId: 'party-owned-by-someone-else' });
  assert.deepEqual(query.where, { userId: 'commerce-b', partyId: 'party-owned-by-someone-else' });
  assert.deepEqual(result.purchases, []);
});

test('empty pages are explicit and page sizes are validated', async () => {
  assert.deepEqual(await signedIn().events.commerce.mine(), { kind: 'passes', passes: [], nextCursor: null });
  await assert.rejects(() => signedIn().events.commerce.mine({ limit: 51 }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => signedIn().events.commerce.mine({ limit: 0 }), { code: 'BAD_REQUEST' });
});
