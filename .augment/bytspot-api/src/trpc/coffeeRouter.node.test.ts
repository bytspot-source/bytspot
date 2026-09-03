import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const coffeeSpot = db.coffeeSpot as any;
const coffeeReservation = db.coffeeReservation as any;
const planItem = db.planItem as any;

const requesterContext: Context = { user: { userId: 'requester-id', email: 'requester@bytspot.com' }, clientRateLimitKey: 'test-coffee-requester' };
const strangerContext: Context = { user: { userId: 'stranger-id', email: 'stranger@bytspot.com' }, clientRateLimitKey: 'test-coffee-stranger' };
const publicContext: Context = { user: null as any, clientRateLimitKey: 'test-coffee-public' };

const caller = () => createCaller(requesterContext);
const stranger = () => createCaller(strangerContext);
const publicCaller = () => createCaller(publicContext);

const idempotencyKey = '00000000-0000-4000-8000-000000000041';

beforeEach(() => {
  (db as any).$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  coffeeSpot.findMany = async () => [];
  coffeeSpot.findFirst = async () => null;
  coffeeReservation.findUnique = async () => null;
  coffeeReservation.findFirst = async () => null;
  coffeeReservation.create = async ({ data }: any) => ({
    id: 'res-1',
    coffeeSpotId: data.coffeeSpotId,
    status: 'pending',
    holdExpiresAt: data.holdExpiresAt,
    requestedFor: data.requestedFor,
    partySize: data.partySize,
  });
  coffeeReservation.update = async ({ data }: any) => ({ id: 'res-1', status: data.status });
  planItem.updateMany = async () => ({ count: 1 });
});

// \u2500\u2500\u2500 list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test('list is public, active-only, and hides owner and internals', async () => {
  let where: any = null;
  coffeeSpot.findMany = async (args: any) => {
    where = args.where;
    return [
      { id: 's-1', name: 'Highland Bakery', areaLabel: 'Midtown', latitude: 33.79, longitude: -84.37, holdMinutes: 15 },
      { id: 's-2', name: 'Octane', areaLabel: 'Westside', latitude: 33.78, longitude: -84.42, holdMinutes: 20 },
    ];
  };
  const result = await publicCaller().coffee.list({});
  assert.deepEqual(where, { active: true });
  // Only card-fit fields ever leave the router.
  assert.deepEqual(Object.keys(result.spots[0]).sort(), ['areaLabel', 'holdMinutes', 'id', 'name']);
  assert.equal(result.spots.length, 2);
});

test('list ranks by proximity when coordinates are given, and filters beyond the radius', async () => {
  coffeeSpot.findMany = async () => [
    { id: 's-far', name: 'Far', areaLabel: null, latitude: 40.0, longitude: -74.0, holdMinutes: 15 },
    { id: 's-near', name: 'Near', areaLabel: null, latitude: 33.79, longitude: -84.37, holdMinutes: 15 },
    { id: 's-nocoords', name: 'Ghost', areaLabel: null, latitude: null, longitude: null, holdMinutes: 15 },
  ];
  const result = await publicCaller().coffee.list({ near: { latitude: 33.78, longitude: -84.38, radiusKm: 25 } });
  // Nearest first, far dropped by radius, unlocated dropped for lack of coords.
  assert.deepEqual(result.spots.map((s) => s.id), ['s-near']);
});

// \u2500\u2500\u2500 reservations.create \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test('The DB, not the client, computes the hold window', async () => {
  coffeeSpot.findFirst = async () => ({ id: 's-1', holdMinutes: 20 });
  let seeded: any = null;
  coffeeReservation.create = async ({ data }: any) => {
    seeded = data;
    return { id: 'res-1', coffeeSpotId: data.coffeeSpotId, status: 'pending', holdExpiresAt: data.holdExpiresAt, requestedFor: data.requestedFor, partySize: data.partySize };
  };
  const requestedFor = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const result = await caller().coffee.reservations.create({ coffeeSpotId: 's-1', idempotencyKey, partySize: 2, requestedFor });

  // holdExpiresAt is computed as now + spot.holdMinutes, never trusted from the caller.
  assert.ok(seeded.holdExpiresAt instanceof Date);
  const holdMs = seeded.holdExpiresAt.getTime() - Date.now();
  assert.ok(holdMs > 18 * 60_000 && holdMs < 22 * 60_000, `holdMs=${holdMs}ms out of the 20-minute band`);
  assert.equal(result.status, 'pending');
  assert.equal(result.coffeeSpotId, 's-1');
});

test('An inactive spot is indistinguishable from missing, and a past time is refused', async () => {
  coffeeSpot.findFirst = async () => null;
  await assert.rejects(
    () => caller().coffee.reservations.create({ coffeeSpotId: 's-nope', idempotencyKey, partySize: 2, requestedFor: new Date(Date.now() + 60 * 60 * 1000) }),
    { code: 'NOT_FOUND' },
  );
  coffeeSpot.findFirst = async () => ({ id: 's-1', holdMinutes: 15 });
  await assert.rejects(
    () => caller().coffee.reservations.create({ coffeeSpotId: 's-1', idempotencyKey, partySize: 2, requestedFor: new Date(Date.now() - 10 * 60_000) }),
    { code: 'BAD_REQUEST' },
  );
  // The horizon rule keeps this a hold, not a month-out booking.
  await assert.rejects(
    () => caller().coffee.reservations.create({ coffeeSpotId: 's-1', idempotencyKey, partySize: 2, requestedFor: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000) }),
    { code: 'BAD_REQUEST' },
  );
});

test('The same idempotency key returns the winning reservation, and a race resolves to it too', async () => {
  coffeeSpot.findFirst = async () => ({ id: 's-1', holdMinutes: 15 });
  const requestedFor = new Date(Date.now() + 60 * 60 * 1000);

  // First: the row is already in the table under this key. Create must not run.
  coffeeReservation.findUnique = async () => ({
    id: 'res-existing', coffeeSpotId: 's-1', status: 'pending', holdExpiresAt: new Date(Date.now() + 15 * 60_000),
    requestedFor, partySize: 2,
  });
  let created = false;
  coffeeReservation.create = async () => { created = true; return {} as any; };
  const first = await caller().coffee.reservations.create({ coffeeSpotId: 's-1', idempotencyKey, partySize: 2, requestedFor });
  assert.equal(first.id, 'res-existing');
  assert.equal(created, false);

  // Second: no row exists yet, but a concurrent create wins between our
  // findUnique and our create. The router recovers by re-reading.
  coffeeReservation.findUnique = async () => null;
  let calls = 0;
  coffeeReservation.findUnique = async () => (calls++ === 0 ? null : {
    id: 'res-racing', coffeeSpotId: 's-1', status: 'pending', holdExpiresAt: new Date(Date.now() + 15 * 60_000),
    requestedFor, partySize: 2,
  });
  coffeeReservation.create = async () => { throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }); };
  const second = await caller().coffee.reservations.create({ coffeeSpotId: 's-1', idempotencyKey, partySize: 2, requestedFor });
  assert.equal(second.id, 'res-racing');
});

test('A live hold on the same spot blocks a second concurrent request', async () => {
  coffeeSpot.findFirst = async () => ({ id: 's-1', holdMinutes: 15 });
  coffeeReservation.findFirst = async () => ({ id: 'res-live' });
  await assert.rejects(
    () => caller().coffee.reservations.create({ coffeeSpotId: 's-1', idempotencyKey, partySize: 2, requestedFor: new Date(Date.now() + 60 * 60 * 1000) }),
    { code: 'CONFLICT' },
  );
});

// \u2500\u2500\u2500 reservations.cancel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test('Cancel is requester-only, indistinguishable from missing to anyone else', async () => {
  coffeeReservation.findUnique = async () => ({ id: 'res-1', requestedByUserId: 'requester-id', status: 'pending', planItem: null });
  await assert.rejects(() => stranger().coffee.reservations.cancel({ reservationId: 'res-1' }), { code: 'NOT_FOUND' });
  assert.deepEqual(await caller().coffee.reservations.cancel({ reservationId: 'res-1' }), { status: 'cancelled' });
});

test('Cancel is idempotent on terminal states, and cancels the attached Plan item in one write', async () => {
  for (const terminal of ['cancelled', 'declined', 'expired'] as const) {
    coffeeReservation.findUnique = async () => ({ id: 'res-1', requestedByUserId: 'requester-id', status: terminal, planItem: null });
    assert.deepEqual(await caller().coffee.reservations.cancel({ reservationId: 'res-1' }), { status: terminal });
  }

  // A pending reservation attached to a Plan cancels its item too. A booking
  // that landed between the read and the write is not silently stranded.
  coffeeReservation.findUnique = async () => ({ id: 'res-1', requestedByUserId: 'requester-id', status: 'pending', planItem: { id: 'item-1' } });
  let itemWhere: any = null;
  planItem.updateMany = async (args: any) => { itemWhere = args.where; return { count: 1 }; };
  await caller().coffee.reservations.cancel({ reservationId: 'res-1' });
  assert.deepEqual(itemWhere, { id: 'item-1', status: { not: 'booked' } });
});
