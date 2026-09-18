import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { db } from '../lib/db';
import { createCallerFactory } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import { buildDemandSnapshot, respondToDemand, NoCapacity, NotFound } from './demandFeed';
import { DEMAND_DEFAULTS } from './demand';

/**
 * The rail, end to end, against a real database.
 *
 * Everything else about demand is unit tested against stubs, which proves the
 * logic and nothing about the schema. This proves the parts a stub cannot: that
 * the CHECK constraints accept what the code writes, that the bounding-box
 * query actually selects, and that the state machine survives a round trip
 * through Postgres.
 *
 * Skipped when no database is reachable, so the suite still runs on a laptop
 * without one. CI always has one.
 */

const createCaller = createCallerFactory(appRouter);

let reachable = false;
const ids = {
  user: `rail-user-${Date.now()}`,
  seller: `rail-seller-${Date.now()}`,
  location: `rail-loc-${Date.now()}`,
  seat: `rail-seat-${Date.now()}`,
  window: `rail-win-${Date.now()}`,
};

/** Midtown Atlanta, where the seller and the guest both are. */
const MIDTOWN = { lat: 33.7866, lng: -84.3833 };

function atlantaEveningTomorrow(): { earliest: Date; latest: Date } {
  // Far enough ahead to clear the contract's lead time, and inside the window
  // the seller declared once it is read back in their own timezone.
  const base = new Date(Date.now() + 26 * 60 * 60 * 1000);
  return { earliest: base, latest: new Date(base.getTime() + 6 * 60 * 60 * 1000) };
}

before(async () => {
  try {
    await db.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    return;
  }

  await db.user.create({
    data: { id: ids.user, email: `${ids.user}@bytspot.test`, name: 'Rail Guest', password: 'unused-in-test' },
  });
  await db.vendorSeller.create({
    data: { id: ids.seller, legalName: 'Rail Kitchen', state: 'ACTIVE' },
  });
  await db.vendorLocation.create({
    data: {
      id: ids.location,
      sellerId: ids.seller,
      label: 'Rail Kitchen Midtown',
      kind: 'fixed',
      state: 'ACTIVE',
      lat: MIDTOWN.lat,
      lng: MIDTOWN.lng,
      // Without this the derivation refuses to produce slots at all.
      timezone: 'America/New_York',
    },
  });
  await db.vendorSeat.create({
    data: { id: ids.seat, sellerId: ids.seller, userId: ids.user, role: 'owner', state: 'ACTIVE' },
  });
  await db.vendorAvailabilityWindow.create({
    data: {
      id: ids.window,
      sellerId: ids.seller,
      locationId: ids.location,
      domain: 'dining',
      skuTemplateId: 'dining.table',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      openMins: 17 * 60,
      closeMins: 22 * 60,
      quantity: 6,
      slotKind: 'rolling',
      slotMinutes: 60,
      leadTimeMins: 60,
      horizonDays: 30,
      priceCents: 5000,
      maxGuests: 6,
      active: true,
    },
  });
});

after(async () => {
  if (!reachable) return;
  await db.demand.deleteMany({ where: { raisedByUserId: ids.user } });
  await db.vendorAvailabilityWindow.deleteMany({ where: { sellerId: ids.seller } });
  await db.vendorSeat.deleteMany({ where: { sellerId: ids.seller } });
  await db.vendorLocation.deleteMany({ where: { sellerId: ids.seller } });
  await db.vendorSeller.deleteMany({ where: { id: ids.seller } });
  await db.user.deleteMany({ where: { id: ids.user } });
  await db.$disconnect();
});

function guest() {
  return createCaller({ user: { userId: ids.user, email: `${ids.user}@bytspot.test` }, clientRateLimitKey: 'rail' } as Context);
}

async function seat() {
  const locations = await db.vendorLocation.findMany({ where: { sellerId: ids.seller } });
  return { sellerId: ids.seller, seatId: ids.seat, capabilities: ['SELL'], locations };
}

test('a published need reaches the seller who can answer it, and is offered against', async (t) => {
  if (!reachable) return t.skip('no database');

  const when = atlantaEveningTomorrow();
  const published = await guest().demand.publish({
    category: 'dining',
    partySize: 2,
    earliest: when.earliest,
    latest: when.latest,
    latitude: MIDTOWN.lat,
    longitude: MIDTOWN.lng,
  });
  assert.equal(published.state, 'OPEN');

  // The feed finds it through the bounding box, matches it against real
  // derived slots, and promotes it because somebody can answer.
  const feed = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  const seen = feed.demand.find((item) => item.id === published.id);
  assert.ok(seen, 'the seller should see the request');
  assert.equal(seen.state, 'MATCHED');

  const offering = feed.supply.find((item) => item.bookableId === ids.window);
  assert.ok(offering, 'the seller should see their own capacity');
  assert.ok(offering.slots.length > 0, 'the window should derive slots');

  // Promotion is persisted, not just reported.
  assert.equal((await db.demand.findUnique({ where: { id: published.id } }))!.state, 'MATCHED');

  const after = await respondToDemand(await seat(), published.id, { operation: 'OFFER', bookableId: ids.window });
  assert.equal(after.demand.find((item) => item.id === published.id)?.state, 'OFFERED');

  const offer = await db.offer.findFirst({ where: { demandId: published.id } });
  assert.ok(offer, 'an offer row should exist');
  assert.equal(offer.state, 'OFFERED');
  assert.equal(offer.priceCents, 5000);
  // The offered time is a real derived slot inside the window the guest asked
  // for, widened by the flexibility the contract grants and by no more than
  // that. Not simply the earliest thing the seller had.
  const slack = DEMAND_DEFAULTS.flexibilityMins * 60_000;
  assert.ok(offer.startsAt.getTime() >= when.earliest.getTime() - slack);
  assert.ok(offer.startsAt.getTime() <= when.latest.getTime() + slack);

  // And the guest can see it, which is the whole point of publishing.
  const mine = await guest().demand.mine();
  const visible = mine.find((item) => item.id === published.id);
  assert.equal(visible?.offers.length, 1);
  assert.equal(visible?.offers[0].where, 'Rail Kitchen Midtown');
});

test('demand nobody can answer still reaches the feed, unmatched', async (t) => {
  if (!reachable) return t.skip('no database');

  // A dining room cannot answer a request for parking. The vendor is entitled
  // to see that this was asked for near them and went unanswered.
  const when = atlantaEveningTomorrow();
  const published = await guest().demand.publish({
    category: 'parking',
    partySize: 1,
    earliest: when.earliest,
    latest: when.latest,
    latitude: MIDTOWN.lat,
    longitude: MIDTOWN.lng,
  });

  const feed = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  const seen = feed.demand.find((item) => item.id === published.id);
  assert.ok(seen, 'unanswerable demand must still be reported');
  // Not promoted, because nothing this seller has can answer it.
  assert.equal(seen.state, 'OPEN');
});

test('the database refuses a category the contract does not name', async (t) => {
  if (!reachable) return t.skip('no database');

  // The API validates this too, but the CHECK constraint is the backstop that
  // a future writer bypassing the router still hits.
  const when = atlantaEveningTomorrow();
  await assert.rejects(
    () =>
      db.demand.create({
        data: {
          raisedByUserId: ids.user,
          category: 'eat_drink',
          partySize: 2,
          earliest: when.earliest,
          latest: when.latest,
          latitude: MIDTOWN.lat,
          longitude: MIDTOWN.lng,
          radiusMiles: 15,
          expiresAt: when.latest,
        },
      }),
    /violates check constraint|constraint/i,
  );
});

test('a far-away need is outside the box and never reaches this seller', async (t) => {
  if (!reachable) return t.skip('no database');

  const when = atlantaEveningTomorrow();
  const published = await guest().demand.publish({
    category: 'dining',
    partySize: 2,
    earliest: when.earliest,
    latest: when.latest,
    // Manhattan.
    latitude: 40.7549,
    longitude: -73.984,
    radiusMiles: 5,
  });

  const feed = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  assert.equal(feed.demand.find((item) => item.id === published.id), undefined);
});

test('a withdrawn need leaves the feed and releases the offer', async (t) => {
  if (!reachable) return t.skip('no database');

  const when = atlantaEveningTomorrow();
  const published = await guest().demand.publish({
    category: 'dining',
    partySize: 2,
    earliest: when.earliest,
    latest: when.latest,
    latitude: MIDTOWN.lat,
    longitude: MIDTOWN.lng,
  });

  await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  await respondToDemand(await seat(), published.id, { operation: 'OFFER', bookableId: ids.window });

  await guest().demand.withdraw({ demandId: published.id });

  const feed = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  assert.equal(feed.demand.find((item) => item.id === published.id), undefined);

  // The seller is no longer holding a table for somebody who has gone.
  const offer = await db.offer.findFirst({ where: { demandId: published.id } });
  assert.equal(offer?.state, 'WITHDRAWN');
});

test('a seller cannot answer from a window that is not theirs', async (t) => {
  if (!reachable) return t.skip('no database');

  const when = atlantaEveningTomorrow();
  const published = await guest().demand.publish({
    category: 'dining',
    partySize: 2,
    earliest: when.earliest,
    latest: when.latest,
    latitude: MIDTOWN.lat,
    longitude: MIDTOWN.lng,
  });
  await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());

  const answering = await seat();
  await assert.rejects(
    () => respondToDemand(answering, published.id, { operation: 'OFFER', bookableId: 'window-belonging-to-nobody' }),
    (err: unknown) => err instanceof NotFound && err.what === 'offering',
  );
});

test('an offer is refused when the window cannot actually cover the party', async (t) => {
  if (!reachable) return t.skip('no database');

  // Seven people against a six-seat table. The console may have offered it from
  // a stale feed; the re-derivation at write time is what catches it.
  const when = atlantaEveningTomorrow();
  const published = await guest().demand.publish({
    category: 'dining',
    partySize: 7,
    earliest: when.earliest,
    latest: when.latest,
    latitude: MIDTOWN.lat,
    longitude: MIDTOWN.lng,
  });

  // Promote it by hand: the feed would not, which is itself the correct
  // behaviour, but the write path must refuse independently.
  await db.demand.update({ where: { id: published.id }, data: { state: 'MATCHED' } });

  const answering = await seat();
  await assert.rejects(
    () => respondToDemand(answering, published.id, { operation: 'OFFER', bookableId: ids.window }),
    (err: unknown) => err instanceof NoCapacity,
  );
  assert.equal(await db.offer.count({ where: { demandId: published.id } }), 0);
});
