import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { acceptOffer, OfferGone, SlotTaken } from './acceptOffer';
import { setWindowIntent } from './windowIntent';
import { createCallerFactory } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import { buildDemandSnapshot, respondToDemand, NoCapacity, NotFound } from './demandFeed';
import { DEMAND_DEFAULTS } from './demand';
import { bookableCreateData, offerToBookableSnapshot } from '../services/bookableProjection';

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

const TZ = 'America/New_York';
let reachable = false;
const ids = {
  user: `rail-user-${Date.now()}`,
  seller: `rail-seller-${Date.now()}`,
  location: `rail-loc-${Date.now()}`,
  seat: `rail-seat-${Date.now()}`,
  window: `rail-win-${Date.now()}`,
  plan: `rail-plan-${Date.now()}`,
  planItem: `rail-item-${Date.now()}`,
};

/** Midtown Atlanta, where the seller and the guest both are. */
const MIDTOWN = { lat: 33.7866, lng: -84.3833 };

/** Minutes east of UTC in Atlanta at a given instant, so DST is never assumed. */
function atlantaOffsetMinutes(at: Date): number {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')!.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Tomorrow evening as the seller experiences it.
 *
 * Built in Atlanta's wall clock rather than by adding hours to now: the seller
 * declared 17:00-22:00 in their own timezone, so a window computed in UTC
 * matches or misses depending on what time of day the suite happens to run.
 * It passed in CI only because CI ran in the UTC evening.
 */
function atlantaEveningTomorrow(): { earliest: Date; latest: Date } {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(tomorrow);
  const field = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const offset = atlantaOffsetMinutes(tomorrow);
  const atHour = (hour: number) =>
    new Date(Date.UTC(field('year'), field('month') - 1, field('day'), hour, 0, 0) - offset * 60_000);
  // Inside the declared hours with room either side, and always well clear of
  // the seller's lead time.
  return { earliest: atHour(18), latest: atHour(21) };
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

// Each test starts with no live requests of its own. Six asks share one
// guest here, and the five-request cap is real, so without this the later
// tests fail as rate-limited rather than on what they assert. Removing the
// demand takes its offers and its append-only event log with it; the log
// refuses to be deleted on its own, by design.
beforeEach(async () => {
  if (!reachable) return;
  // Items first. A filed booking holds its offer down by design, so the
  // cascade from the demand cannot run while one still points at it.
  await db.planItem.deleteMany({ where: { plan: { creatorUserId: ids.user } } });
  await db.demand.deleteMany({ where: { raisedByUserId: { startsWith: ids.user } } });
  // Capacity too: the slots derive from one window, so a test that fills the
  // seller's evening leaves the next one with nothing to sell.
  await db.vendorSlotCommitment.deleteMany({ where: { windowId: ids.window } });
});

after(async () => {
  if (!reachable) return;
  await db.planItem.deleteMany({ where: { plan: { creatorUserId: ids.user } } });
  await db.demand.deleteMany({ where: { raisedByUserId: { startsWith: ids.user } } });
  await db.plan.deleteMany({ where: { creatorUserId: ids.user } });
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

test('a plan raises the ask, and it reaches the seller like any other', async (t) => {
  if (!reachable) return t.skip('no database');

  const when = atlantaEveningTomorrow();
  await db.plan.create({
    data: {
      id: ids.plan,
      creatorUserId: ids.user,
      idempotencyKey: `${ids.plan}-key`,
      joinToken: `${ids.plan}-token`,
      title: 'Dinner in Midtown',
      intent: 'dinner',
      startsAt: when.earliest,
      endsAt: when.latest,
      latitude: MIDTOWN.lat,
      longitude: MIDTOWN.lng,
      partySize: 4,
      needs: ['dining'],
    },
  });

  const raised = await guest().demand.fromPlan({ planId: ids.plan, needKind: 'dining' });
  assert.equal(raised.category, 'dining');

  // Read back from the database rather than the return value: the plan link is
  // what lets a guest see which gap this was asked for.
  const stored = await db.demand.findUnique({ where: { id: raised.id } });
  assert.equal(stored!.planId, ids.plan);
  assert.equal(stored!.partySize, 4);

  const feed = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  assert.equal(feed.demand.find((entry) => entry.id === raised.id)?.state, 'MATCHED');

  // The same gap must not be asked about twice while the first ask is live.
  await assert.rejects(() => guest().demand.fromPlan({ planId: ids.plan, needKind: 'dining' }));

  await guest().demand.withdraw({ demandId: raised.id });
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
  // The feed is what promotes a request to MATCHED, and only a MATCHED
  // request may be answered. Offering without reading the feed is not a path
  // the console can take.
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

/**
 * Accepting.
 *
 * The first point where the rail commits to anything, and the first place a
 * mistake costs a real business a real evening.
 */

async function offeredTo(category = 'dining', partySize = 2) {
  const when = atlantaEveningTomorrow();
  const published = await guest().demand.publish({
    category,
    partySize,
    earliest: when.earliest,
    latest: when.latest,
    latitude: MIDTOWN.lat,
    longitude: MIDTOWN.lng,
  });
  // The feed is what promotes a request to MATCHED, and only a MATCHED
  // request may be answered. Offering without reading the feed is not a path
  // the console can take.
  await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  await respondToDemand(await seat(), published.id, { operation: 'OFFER', bookableId: ids.window });
  const offer = await db.offer.findFirstOrThrow({ where: { demandId: published.id, state: 'OFFERED' } });
  return { demandId: published.id, offer };
}

test('accepting commits the slot the seller actually has', async (t) => {
  if (!reachable) return t.skip('no database');

  const { demandId, offer } = await offeredTo();

  // Offering holds nothing: a seller may answer ten requests from one window
  // hoping one lands. That is selling, not overbooking.
  const beforeAccept = await db.vendorSlotCommitment.findUnique({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: offer.startsAt } },
  });
  assert.equal(beforeAccept?.committed ?? 0, 0, 'an offer must not consume capacity');

  const taken = await guest().demand.acceptOffer({ offerId: offer.id });
  assert.equal(taken.offerId, offer.id);
  assert.ok(taken.where.length > 0, 'the guest is told where they are going');

  const committed = await db.vendorSlotCommitment.findUniqueOrThrow({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: offer.startsAt } },
  });
  assert.equal(committed.committed, 1, 'accepting is what commits capacity');

  const demand = await db.demand.findUniqueOrThrow({ where: { id: demandId } });
  assert.equal(demand.state, 'BOOKED');
  const accepted = await db.offer.findUniqueOrThrow({ where: { id: offer.id } });
  assert.equal(accepted.state, 'ACCEPTED');

  // The ledger has to be able to answer "who took what, and for how much".
  const events = await db.demandEvent.findMany({ where: { demandId, kind: 'ACCEPTED' } });
  assert.equal(events.length, 1);
});

test('two guests cannot take the last one', async (t) => {
  if (!reachable) return t.skip('no database');

  // Fill the window to its declared quantity, then offer one more and take it.
  const { offer } = await offeredTo();
  await db.vendorSlotCommitment.upsert({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: offer.startsAt } },
    create: { windowId: ids.window, startsAt: offer.startsAt, committed: 6 },
    update: { committed: 6 },
  });

  await assert.rejects(
    () => guest().demand.acceptOffer({ offerId: offer.id }),
    (error: { code?: string; message?: string }) => {
      assert.equal(error.code, 'CONFLICT');
      // Named plainly: the guest did nothing wrong and should ask again.
      assert.match(String(error.message), /took the last one/i);
      return true;
    },
  );

  // The refusal must leave nothing behind: no phantom booking, no lost request.
  const stillOffered = await db.offer.findUniqueOrThrow({ where: { id: offer.id } });
  assert.equal(stillOffered.state, 'OFFERED', 'a failed accept must not consume the offer');
  const committed = await db.vendorSlotCommitment.findUniqueOrThrow({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: offer.startsAt } },
  });
  assert.equal(committed.committed, 6, 'a failed accept must not commit capacity');
});

test('an expired hold cannot be accepted', async (t) => {
  if (!reachable) return t.skip('no database');

  const { offer } = await offeredTo();

  // The clock is moved rather than the hold: the database refuses a
  // hold_expires_at at or before created_at, which is the right rule and means
  // an expired hold cannot be faked by writing one.
  const afterTheHold = new Date(offer.holdExpiresAt.getTime() + 60_000);
  await assert.rejects(
    () => acceptOffer({ offerId: offer.id, userId: ids.user, now: afterTheHold }),
    (error: Error) => {
      assert.match(error.message, /expired/i);
      return true;
    },
  );

  // Nothing was taken on the way to refusing.
  const untouched = await db.offer.findUniqueOrThrow({ where: { id: offer.id } });
  assert.equal(untouched.state, 'OFFERED');
  const commitment = await db.vendorSlotCommitment.findUnique({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: offer.startsAt } },
  });
  assert.equal(commitment?.committed ?? 0, 0);
});

test('an offer made to somebody else is not found, not forbidden', async (t) => {
  if (!reachable) return t.skip('no database');

  const { offer } = await offeredTo();
  const stranger = createCaller({
    user: { userId: `${ids.user}-stranger`, email: 'stranger@bytspot.test' },
    clientRateLimitKey: 'rail-stranger',
  } as Context);

  // NOT_FOUND rather than FORBIDDEN: a stranger probing offer ids must not
  // learn which ones exist.
  await assert.rejects(
    () => stranger.demand.acceptOffer({ offerId: offer.id }),
    (error: { code?: string }) => {
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    },
  );
});

/**
 * Vendor intent.
 *
 * Capability used to be inferred from which kind of row existed. This is the
 * seller saying what they offer, and the platform holding them to it.
 */

test('a window that has not offered to answer asks never reaches the feed', async (t) => {
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

  // The seller withdraws the intent. Nothing else about the window changes:
  // same hours, same capacity, same price, still active. `none` exists so that
  // declining is expressible without deleting or deactivating the window.
  await db.$executeRawUnsafe(
    `UPDATE "vendor_availability_windows" SET "intent" = 'none' WHERE "id" = $1`,
    ids.window,
  );

  try {
    const feed = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
    // The request still exists and is still near them. It simply has nothing
    // here to answer it, so it stays unmatched rather than being promoted.
    const seen = feed.demand.find((item) => item.id === published.id);
    assert.ok(seen, 'the ask is still reported');
    assert.equal(seen.state, 'OPEN');
    assert.equal(feed.supply.length, 0, 'a window without the intent is not sellable supply');

    // And the direct path is closed too: naming the window id explicitly must
    // not do what the feed refused to offer.
    const seatNow = await seat();
    await assert.rejects(
      () => respondToDemand(seatNow, published.id, { operation: 'OFFER', bookableId: ids.window }),
      (error: Error) => {
        assert.match(error.message, /offering/i);
        return true;
      },
    );

    const offers = await db.offer.findMany({ where: { demandId: published.id } });
    assert.equal(offers.length, 0, 'no offer may exist from a window that does not answer asks');
  } finally {
    await db.$executeRawUnsafe(
      `UPDATE "vendor_availability_windows" SET "intent" = 'request' WHERE "id" = $1`,
      ids.window,
    );
  }
});

test('the database refuses an intent the platform cannot honour', async (t) => {
  if (!reachable) return t.skip('no database');

  // book, order and redirect are not words a seller can say yet. Nothing behind
  // them is built, and a vocabulary that can name a promise the platform cannot
  // keep is how the trust gate stops meaning anything.
  for (const intent of ['book', 'order', 'redirect']) {
    await assert.rejects(
      () =>
        db.$executeRawUnsafe(
          `UPDATE "vendor_availability_windows" SET "intent" = $1 WHERE "id" = $2`,
          intent,
          ids.window,
        ),
      /violates check constraint|constraint/i,
      `${intent} must not be storable until the rail behind it exists`,
    );
  }
});

test('the console mutation is what turns asks on and off', async (t) => {
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

  const declined = await setWindowIntent({ sellerId: ids.seller, windowId: ids.window, intent: 'none' });
  assert.equal(declined.intent, 'none');
  // The console is told what it agreed to in words, not just a token echoed
  // back: a seller changing what their business accepts should read a sentence.
  assert.match(declined.meaning, /no asks/i);

  const quiet = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  assert.equal(quiet.supply.length, 0, 'declining must actually stop the asks');
  assert.equal(quiet.demand.find((item) => item.id === published.id)?.state, 'OPEN');

  const accepting = await setWindowIntent({ sellerId: ids.seller, windowId: ids.window, intent: 'request' });
  assert.equal(accepting.intent, 'request');
  assert.match(accepting.meaning, /offer/i);

  const live = await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  assert.equal(live.supply.length, 1, 'saying yes must put the window back in the feed');
  assert.equal(live.demand.find((item) => item.id === published.id)?.state, 'MATCHED');
});

test('a seat cannot speak for a window that is not its business', async (t) => {
  if (!reachable) return t.skip('no database');

  // Not-found rather than forbidden: the id is not theirs to learn about.
  await assert.rejects(
    () => setWindowIntent({ sellerId: `${ids.seller}-other`, windowId: ids.window, intent: 'none' }),
    (error: Error) => {
      assert.match(error.message, /offering/i);
      return true;
    },
  );

  // And the window is untouched by the attempt.
  const untouched = await db.vendorAvailabilityWindow.findUniqueOrThrow({ where: { id: ids.window } });
  assert.equal(untouched.intent, 'request');
});

/**
 * Races.
 *
 * Both of these passed the sequential suite and failed in reality. A rail that
 * sells capacity is only correct under simultaneous buyers.
 */

test('two accepts into one empty slot both succeed when there is room for both', async (t) => {
  if (!reachable) return t.skip('no database');

  // Two separate demands on the same empty slot, on a window with room for six.
  // (One test user raises both; the race is between the demands, not the users.)
  // Nothing here should be scarce.
  const first = await offeredTo();
  const second = await offeredTo();
  assert.equal(first.offer.startsAt.getTime(), second.offer.startsAt.getTime(), 'same slot, or this proves nothing');

  const results = await Promise.allSettled([
    acceptOffer({ offerId: first.offer.id, userId: ids.user }),
    acceptOffer({ offerId: second.offer.id, userId: ids.user }),
  ]);

  // Whoever loses the race to create the commitment row must continue to the
  // increment, not be told the slot is full. Being refused here would be a
  // vendor losing a booking they had capacity for.
  const refused = results.filter((result) => result.status === 'rejected');
  assert.deepEqual(refused.map((r) => (r as PromiseRejectedResult).reason?.message), [],
    'neither accept may fail while the slot has room');

  const commitment = await db.vendorSlotCommitment.findUniqueOrThrow({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: first.offer.startsAt } },
  });
  assert.equal(commitment.committed, 2, 'both bookings must be counted, exactly once each');
});

test('two accepts racing for the last unit: one wins, the other is told plainly', async (t) => {
  if (!reachable) return t.skip('no database');

  const first = await offeredTo();
  const second = await offeredTo();

  // One unit left.
  await db.vendorSlotCommitment.upsert({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: first.offer.startsAt } },
    create: { windowId: ids.window, startsAt: first.offer.startsAt, committed: 5 },
    update: { committed: 5 },
  });

  const results = await Promise.allSettled([
    acceptOffer({ offerId: first.offer.id, userId: ids.user }),
    acceptOffer({ offerId: second.offer.id, userId: ids.user }),
  ]);

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one may win');
  const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  // A domain refusal, not a database error surfacing as a 500.
  assert.ok(loser.reason instanceof SlotTaken, `expected SlotTaken, got ${loser.reason?.constructor?.name}`);

  const commitment = await db.vendorSlotCommitment.findUniqueOrThrow({
    where: { windowId_startsAt: { windowId: ids.window, startsAt: first.offer.startsAt } },
  });
  assert.equal(commitment.committed, 6, 'the seller must never be sold past what they declared');
});

// Honest limit: this asserts the invariant, it does not reproduce the deadlock
// it guards against. The collision needs both transactions interleaved mid-way,
// which did not occur in repeated runs with the demand lock removed; it was
// found with a trigger widening the window. Kept because the invariant is the
// thing that must hold, not because it proves the lock.
test('two sellers answer, the guest accepts both at once, and only one sticks', async (t) => {
  if (!reachable) return t.skip('no database');

  // One demand, two offers. Without a deliberate order these can deadlock on
  // each other's offer rows and the loser gets a raw database error.
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
  const offers = await db.offer.findMany({ where: { demandId: published.id, state: 'OFFERED' } });
  // A second offer on the same demand, as a second seat would have written it.
  const sibling = await db.offer.create({
    data: {
      demandId: published.id,
      sellerId: offers[0].sellerId,
      locationId: offers[0].locationId,
      windowId: offers[0].windowId,
      skuTemplateId: offers[0].skuTemplateId,
      startsAt: offers[0].startsAt,
      durationMins: offers[0].durationMins,
      priceCents: offers[0].priceCents,
      capacity: offers[0].capacity,
      state: 'OFFERED',
      holdExpiresAt: offers[0].holdExpiresAt,
      createdBySeatId: offers[0].createdBySeatId,
    },
  });

  const results = await Promise.allSettled([
    acceptOffer({ offerId: offers[0].id, userId: ids.user }),
    acceptOffer({ offerId: sibling.id, userId: ids.user }),
  ]);

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'a demand may be booked once');
  const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  // The point of the lock: a named refusal rather than a deadlock.
  assert.ok(loser.reason instanceof OfferGone, `expected OfferGone, got ${loser.reason?.constructor?.name}`);

  const finalOffers = await db.offer.findMany({ where: { demandId: published.id } });
  assert.equal(finalOffers.filter((offer) => offer.state === 'ACCEPTED').length, 1);
  // The seller who lost is released rather than left holding a maybe.
  assert.equal(finalOffers.filter((offer) => offer.state === 'DECLINED').length, 1);
  assert.equal((await db.demand.findUniqueOrThrow({ where: { id: published.id } })).state, 'BOOKED');
});

test('a booking the guest accepted stays visible until the table is in the past', async (t) => {
  if (!reachable) return t.skip('no database');

  const { offer, demandId } = await offeredTo();

  // Before accepting: an open question with an offer to weigh.
  const waiting = (await guest().demand.mine()).find((row) => row.id === demandId);
  assert.equal(waiting?.state, 'OFFERED');
  assert.equal(waiting?.offers.every((each) => each.accepted === false), true);

  await acceptOffer({ offerId: offer.id, userId: ids.user });

  // After accepting: still listed, now as a table they hold. A confirmed
  // booking disappearing from the only screen that showed it would be worse
  // than never having shown it.
  const held = (await guest().demand.mine()).find((row) => row.id === demandId);
  assert.ok(held, 'an accepted booking must not vanish');
  assert.equal(held?.state, 'BOOKED');
  const accepted = held?.offers.filter((each) => each.accepted) ?? [];
  assert.equal(accepted.length, 1, 'exactly the offer they took');
  assert.equal(accepted[0].id, offer.id);
  // The losing offers are not shown back to the guest as if still choosable.
  assert.equal(held?.offers.length, 1);
});

test('a booking stays visible through the meal and goes once the table is done', async (t) => {
  if (!reachable) return t.skip('no database');

  const { offer, demandId } = await offeredTo();
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  // Mid-meal: started, not finished. Dropping it at startsAt would take the
  // confirmation away from a guest who is sitting at the table.
  await db.offer.update({
    where: { id: offer.id },
    data: { startsAt: new Date(Date.now() - 30 * 60_000), durationMins: 90 },
  });
  assert.ok(
    (await guest().demand.mine()).some((row) => row.id === demandId),
    'a booking in progress must still be visible',
  );

  // Finished: history, and no longer returned.
  await db.offer.update({
    where: { id: offer.id },
    data: { startsAt: new Date(Date.now() - 200 * 60_000), durationMins: 90 },
  });
  assert.equal(
    (await guest().demand.mine()).some((row) => row.id === demandId),
    false,
    'a finished booking stops being an answer',
  );
});

test('an offer may not run longer than a day', async (t) => {
  if (!reachable) return t.skip('no database');

  const { offer } = await offeredTo();
  // The bound the read path depends on: if this can be violated, a long
  // booking silently drops out of `mine` instead of staying visible.
  await assert.rejects(
    () => db.offer.update({ where: { id: offer.id }, data: { durationMins: 1441 } }),
    /offers_shape_sane/,
  );
  await db.offer.update({ where: { id: offer.id }, data: { durationMins: 1440 } });
});

/**
 * Filing the table in the Plan.
 *
 * A booking the guest cannot find in the Plan they built is a booking they
 * will assume did not happen.
 */

/** A Plan with one open dining need, distinct per test so asks never collide. */
async function planWithDiningNeed(): Promise<string> {
  const when = atlantaEveningTomorrow();
  const plan = await db.plan.create({
    data: {
      creatorUserId: ids.user,
      idempotencyKey: `${ids.plan}-attach-${randomUUID()}`,
      joinToken: `${ids.plan}-attach-token-${randomUUID()}`,
      title: 'Dinner in Midtown',
      intent: 'dinner',
      startsAt: when.earliest,
      endsAt: when.latest,
      latitude: MIDTOWN.lat,
      longitude: MIDTOWN.lng,
      partySize: 2,
      needs: ['dining'],
      // The creator's own seat. A Plan without one is unreadable even to the
      // person who made it, so a fixture without it is not a Plan.
      participants: { create: { userId: ids.user, role: 'creator', status: 'accepted' } },
    },
  });
  return plan.id;
}

/** Raise from a Plan, get it matched, and take one offer back. */
async function offeredToPlan(planId: string) {
  const raised = await guest().demand.fromPlan({ planId, needKind: 'dining' });
  await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  await respondToDemand(await seat(), raised.id, { operation: 'OFFER', bookableId: ids.window });
  const offer = await db.offer.findFirstOrThrow({ where: { demandId: raised.id, state: 'OFFERED' } });
  return { demandId: raised.id, offer };
}

test('a table won on the rail lands in the Plan it was asked for', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  const item = await db.planItem.findUnique({ where: { offerId: offer.id } });
  assert.ok(item, 'the accepted table must appear in the Plan');
  assert.equal(item!.planId, planId);
  // Filed under the need the guest actually stated, not a guessed one.
  assert.equal(item!.needKind, 'dining');
  assert.equal(item!.title, 'Rail Kitchen Midtown');
  // Capacity is committed, so the item says booked and nothing weaker.
  assert.equal(item!.capability, 'book');
  assert.equal(item!.status, 'booked');
  // Carries the frozen snapshot of what was agreed, not a live lookup.
  assert.equal(item!.bookableId, (await db.offer.findUniqueOrThrow({ where: { id: offer.id } })).bookableId);
});

test('the guest sees the won table when they open the Plan', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  // Through the router the client actually calls, not the row underneath it.
  const plan = await guest().plans.get({ planId });
  const item = plan.items.find((entry) => entry.selectionKey === `vendorOffer:${offer.id}`);
  assert.ok(item, 'the Plan must show the table it won');
  assert.equal(item!.booked, true);
  assert.equal(item!.needKind, 'dining');
  assert.equal(item!.title, 'Rail Kitchen Midtown');
});

test('a booking asked for outside any Plan is still a booking', async (t) => {
  if (!reachable) return t.skip('no database');

  // Its own guest: publishing is rate-limited per user, and the asks above
  // have already spent this window. A limit is not what this test is about.
  const soloUser = `${ids.user}-solo`;
  const solo = createCaller({
    user: { userId: soloUser, email: `${soloUser}@bytspot.test` },
    clientRateLimitKey: 'rail-solo',
  } as Context);

  // Raised from Concierge: no Plan to file it in. The accept must still
  // complete — the demand inbox is where this one lives.
  const when = atlantaEveningTomorrow();
  const published = await solo.demand.publish({
    category: 'dining',
    partySize: 2,
    earliest: when.earliest,
    latest: when.latest,
    latitude: MIDTOWN.lat,
    longitude: MIDTOWN.lng,
  });
  await buildDemandSnapshot(ids.seller, (await seat()).locations, new Date());
  await respondToDemand(await seat(), published.id, { operation: 'OFFER', bookableId: ids.window });
  const offer = await db.offer.findFirstOrThrow({ where: { demandId: published.id, state: 'OFFERED' } });
  const demandId = published.id;
  await acceptOffer({ offerId: offer.id, userId: soloUser });

  assert.equal((await db.demand.findUniqueOrThrow({ where: { id: demandId } })).state, 'BOOKED');
  assert.equal(await db.planItem.findUnique({ where: { offerId: offer.id } }), null);
});

test('a Plan deleted while the ask was live does not take the booking down with it', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer, demandId } = await offeredToPlan(planId);
  await db.plan.update({ where: { id: planId }, data: { deletedAt: new Date() } });

  // The table is real and the seller committed capacity. Refusing the accept
  // because the Plan is gone would punish the guest for tidying up.
  await acceptOffer({ offerId: offer.id, userId: ids.user });
  assert.equal((await db.demand.findUniqueOrThrow({ where: { id: demandId } })).state, 'BOOKED');
  assert.equal(await db.planItem.findUnique({ where: { offerId: offer.id } }), null);
});

test('an accept that arrives mid-delete files nothing in the tombstone', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);

  // Drive the dangerous interleaving rather than hope for it. A delete holds
  // the Plan row and has not committed; the accept arrives in that window.
  // Without the row lock the accept reads a Plan that still looks alive,
  // commits after the delete, and leaves a booking inside a tombstone.
  let accept: Promise<unknown> | null = null;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "plans" WHERE "id" = ${planId} FOR UPDATE`;
    await tx.plan.update({ where: { id: planId }, data: { deletedAt: new Date() } });
    accept = acceptOffer({ offerId: offer.id, userId: ids.user });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, { timeout: 10_000 });
  await accept;

  assert.equal(
    await db.planItem.findUnique({ where: { offerId: offer.id } }),
    null,
    'a booking may not be filed in a Plan that was deleted out from under it',
  );
});

test('a Plan holding a won table refuses to be deleted', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  // The seller committed capacity for this. Deleting the Plan would strand it.
  await assert.rejects(() => guest().plans.delete({ planId }), { code: 'CONFLICT' });
  assert.equal((await db.plan.findUniqueOrThrow({ where: { id: planId } })).deletedAt, null);
});

test('a delete that arrives mid-accept sees the booking and refuses', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  // Stage the other order: an accept holds the Plan row and its item is
  // written but not yet committed when the delete arrives. Without the row
  // lock on the delete side, the supply count runs early, sees nothing to
  // protect, and tombstones a Plan that is about to hold a real table.
  const filed = await db.planItem.findUniqueOrThrow({ where: { offerId: offer.id } });
  await db.planItem.delete({ where: { id: filed.id } });

  let removal: Promise<unknown> | null = null;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "plans" WHERE "id" = ${planId} FOR UPDATE`;
    await tx.planItem.create({
      data: {
        planId, needKind: filed.needKind, title: filed.title, offerId: filed.offerId,
        bookableId: filed.bookableId, capability: 'book', status: 'booked',
        selectionKey: filed.selectionKey,
      },
    });
    removal = assert.rejects(() => guest().plans.delete({ planId }), { code: 'CONFLICT' });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, { timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  await removal;

  assert.equal((await db.plan.findUniqueOrThrow({ where: { id: planId } })).deletedAt, null);
});

test('an offer-backed item must carry the snapshot of the offer it names', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });
  const item = await db.planItem.findUniqueOrThrow({ where: { offerId: offer.id } });

  // Pointing at the right offer while carrying someone else's snapshot would
  // show the guest a price and a time nobody agreed to.
  const stray = offerToBookableSnapshot({
    offerId: `${offer.id}-stray`, where: 'Rail Kitchen Midtown', priceCents: 9900,
    capacity: offer.capacity, startsAt: offer.startsAt, durationMins: offer.durationMins,
  });
  await db.bookable.create({ data: { ...bookableCreateData(stray), snapshotAt: new Date() } });

  await assert.rejects(
    () => db.planItem.update({ where: { id: item.id }, data: { bookableId: stray.id } }),
    /snapshot of offer_id/,
  );
});

test('the shared snapshot is cleared by whichever owner leaves last', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer, demandId } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });
  const item = await db.planItem.findUniqueOrThrow({ where: { offerId: offer.id } });
  const bookableId = item.bookableId!;

  // Item first: the offer still holds the snapshot, so it stays.
  await db.planItem.delete({ where: { id: item.id } });
  assert.ok(await db.bookable.findUnique({ where: { id: bookableId } }), 'the offer still needs it');

  // Offer last: nobody is left holding it.
  await db.demand.delete({ where: { id: demandId } });
  assert.equal(await db.bookable.findUnique({ where: { id: bookableId } }), null, 'no snapshot may outlive both owners');
});

test('the same accepted offer cannot be filed twice, in any Plan', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  // A second Plan and a second snapshot, so neither the shared bookable nor
  // the per-plan selection key is what refuses. One table, filed once.
  const otherPlan = await planWithDiningNeed();
  const snapshot = offerToBookableSnapshot({
    offerId: offer.id,
    where: 'Rail Kitchen Midtown',
    priceCents: offer.priceCents,
    capacity: offer.capacity,
    startsAt: offer.startsAt,
    durationMins: offer.durationMins,
  });
  await db.bookable.create({ data: { ...bookableCreateData(snapshot), snapshotAt: new Date() } });

  await assert.rejects(
    () =>
      db.planItem.create({
        data: {
          planId: otherPlan,
          needKind: 'dining',
          title: 'Rail Kitchen Midtown',
          offerId: offer.id,
          bookableId: snapshot.id,
          capability: 'book',
          status: 'booked',
          selectionKey: `vendorOffer:${offer.id}`,
        },
      }),
    /offer_id/,
  );
});

test('an offer-backed item may not claim to be anything other than booked', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  // Available would invite a second attempt to reserve a table already held.
  await assert.rejects(
    () => db.planItem.update({ where: { offerId: offer.id }, data: { status: 'available' } }),
    /plan_items_vendor_offer_booked_check/,
  );
  // Request understates a committed table.
  await assert.rejects(
    () => db.planItem.update({ where: { offerId: offer.id }, data: { capability: 'request' } }),
    /plan_items_vendor_offer_booked_check/,
  );
  // Cancelling is the one move it is allowed to make.
  await db.planItem.update({ where: { offerId: offer.id }, data: { status: 'cancelled' } });
});

test('an item carries one supply, and an offer is not an exception', async (t) => {
  if (!reachable) return t.skip('no database');

  const planId = await planWithDiningNeed();
  const { offer } = await offeredToPlan(planId);
  await acceptOffer({ offerId: offer.id, userId: ids.user });

  const spot = await db.coffeeSpot.findFirst();
  if (!spot) return t.skip('no coffee spot fixture');
  await assert.rejects(
    () => db.planItem.update({ where: { offerId: offer.id }, data: { coffeeSpotId: spot.id } }),
    /plan_items_selection_supply_check/,
  );
});
