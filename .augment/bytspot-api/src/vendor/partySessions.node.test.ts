import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import {
  SessionInUse,
  SessionPartyNotFound,
  SessionRefused,
  authorPartySession,
  listPartySessions,
  withdrawPartySession,
} from './partySessions';

/**
 * Authoring is the vendor's half of the floor, so the cases that matter are
 * the boundary ones: which Party a business may sell into at all, and what a
 * session may claim once it is in.
 */

const party = db.party as any;
const vendorSeat = db.vendorSeat as any;
const partySession = db.partySession as any;
const partySessionClaim = db.partySessionClaim as any;

const hour = 60 * 60 * 1000;
const startsAt = new Date(Date.now() + 24 * hour);
const endsAt = new Date(Date.now() + 28 * hour);

function draft(over: Record<string, unknown> = {}) {
  return {
    name: 'Front Table', kind: 'table' as const, startsAt, endsAt,
    bottleCount: 4, bottleTerms: 'included' as const, priceCents: 90000, quantity: 2, ...over,
  };
}

let created: any;

beforeEach(() => {
  created = undefined;
  party.findFirst = async () => ({ id: 'party-1', hostUserId: 'host-1' });
  vendorSeat.findFirst = async () => ({ id: 'seat-1' });
  partySession.findMany = async () => [];
  partySession.findFirst = async () => null;
  partySession.create = async (input: any) => { created = input.data; return { id: 'session-1', committed: 0, ...input.data }; };
  partySession.delete = async () => ({ id: 'session-1' });
  partySessionClaim.count = async () => 0;
});

test('A business may only sell into a Party its own host runs', async () => {
  // The host holds no seat here, so this business has no standing to hang a
  // table on their night.
  vendorSeat.findFirst = async () => null;
  await assert.rejects(() => authorPartySession('seller-1', 'party-1', draft()), SessionPartyNotFound);
});

test('A Party a business cannot sell into is not found, not forbidden', async () => {
  // Forbidden would confirm the id names a real Party, which is how a caller
  // maps out other people's nights by probing.
  vendorSeat.findFirst = async () => null;
  await assert.rejects(() => listPartySessions('seller-1', 'party-1'), SessionPartyNotFound);

  party.findFirst = async () => null;
  vendorSeat.findFirst = async () => ({ id: 'seat-1' });
  await assert.rejects(() => listPartySessions('seller-1', 'no-such-party'), SessionPartyNotFound);
});

test('A seat that is only invited is not yet a seat', async () => {
  let seatQuery: any;
  vendorSeat.findFirst = async (input: any) => { seatQuery = input; return null; };
  await assert.rejects(() => authorPartySession('seller-1', 'party-1', draft()), SessionPartyNotFound);
  assert.equal(seatQuery.where.state, 'ACTIVE');
});

test('Supply is arranged before the night is announced, but not after it is called off', async () => {
  // A draft Party is the ordinary case: the floor is set while the night is
  // still being built. A cancelled one is not in the query at all.
  let partyQuery: any;
  party.findFirst = async (input: any) => { partyQuery = input; return { id: 'party-1', hostUserId: 'host-1' }; };
  await authorPartySession('seller-1', 'party-1', draft());
  assert.deepEqual(partyQuery.where.status, { not: 'cancelled' });
});

test('An after-hours session keeps its own hours and address', async () => {
  // Nothing consults the Party's window, which is the point: this session
  // starts after the Party is over, somewhere else.
  await authorPartySession('seller-1', 'party-1', draft({
    name: 'After Hours', kind: 'after-hours',
    startsAt: new Date(Date.now() + 30 * hour), endsAt: new Date(Date.now() + 34 * hour),
    venueName: 'The Annex', lat: 33.77, lng: -84.36,
    bottleTerms: 'minimum', bottleCount: 2, priceCents: 20000,
  }));
  assert.equal(created.venueName, 'The Annex');
  assert.equal(created.lat, 33.77);
  assert.equal(created.bottleTerms, 'minimum');
});

test('A session held where the Party is records no address rather than a copied one', async () => {
  await authorPartySession('seller-1', 'party-1', draft());
  assert.equal(created.venueName, null);
  assert.equal(created.lat, null);
  assert.equal(created.lng, null);
});

test('A vendor cannot open a session with units already taken', async () => {
  // committed is the till's number. Accepting it from the request body would
  // let a vendor publish a table that reads half-sold on arrival.
  await authorPartySession('seller-1', 'party-1', { ...draft(), committed: 5 } as any);
  assert.equal(created.committed, undefined);
});

test('Every complaint about a draft arrives at once', async () => {
  const refusal = await authorPartySession('seller-1', 'party-1', draft({
    name: '   ', endsAt: new Date(startsAt.getTime() - hour), bottleTerms: 'minimum', bottleCount: 0, lat: 33.77,
  })).catch((err) => err);

  assert.ok(refusal instanceof SessionRefused);
  assert.deepEqual(refusal.issues.map((issue: any) => issue.field).sort(), ['bottleCount', 'endsAt', 'lat', 'name']);
});

test('A second session cannot take a name the floor already uses', async () => {
  // validateSessions only sees what it is handed, so the collision with the
  // stored floor is the one worth asserting.
  partySession.findMany = async () => [{ name: 'Front Table', position: 0 }];
  const refusal = await authorPartySession('seller-1', 'party-1', draft({ name: 'front table  ' })).catch((err) => err);
  assert.ok(refusal instanceof SessionRefused);
  assert.deepEqual(refusal.issues, [{ index: 0, field: 'name', message: 'Two sessions cannot share a name.' }]);
});

test('A new session lands after the floor already arranged, including another vendors', async () => {
  // Position is read across the whole Party rather than this seller's rows,
  // so two businesses selling into one night do not both claim slot zero.
  partySession.findMany = async () => [{ name: 'Front Table', position: 0 }, { name: 'Back Booth', position: 3 }];
  await authorPartySession('seller-1', 'party-1', draft({ name: 'Balcony' }));
  assert.equal(created.position, 4);
});

test('Withdrawing a session is refused once somebody is holding it', async () => {
  partySession.findFirst = async () => ({ id: 'session-1', partyId: 'party-1', committed: 1 });
  await assert.rejects(() => withdrawPartySession('seller-1', 'session-1'), SessionInUse);

  // And refused for a claim with no committed unit behind it yet.
  partySession.findFirst = async () => ({ id: 'session-1', partyId: 'party-1', committed: 0 });
  partySessionClaim.count = async () => 1;
  await assert.rejects(() => withdrawPartySession('seller-1', 'session-1'), SessionInUse);
});

test('A session nobody has touched can be withdrawn', async () => {
  let deleted: any;
  partySession.findFirst = async () => ({ id: 'session-1', partyId: 'party-1', committed: 0 });
  partySession.delete = async (input: any) => { deleted = input.where; return { id: 'session-1' }; };
  await withdrawPartySession('seller-1', 'session-1');
  assert.deepEqual(deleted, { id: 'session-1' });
});

test('One business cannot withdraw another businesss session', async () => {
  let query: any;
  partySession.findFirst = async (input: any) => { query = input; return null; };
  await assert.rejects(() => withdrawPartySession('seller-2', 'session-1'), SessionPartyNotFound);
  assert.equal(query.where.sellerId, 'seller-2');
});

test('A listing is scoped to the business that authored it', async () => {
  let query: any;
  partySession.findMany = async (input: any) => { query = input; return []; };
  await listPartySessions('seller-1', 'party-1');
  assert.deepEqual(query.where, { partyId: 'party-1', sellerId: 'seller-1' });
});
