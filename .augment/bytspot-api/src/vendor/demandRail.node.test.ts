import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { acceptOffer, OfferGone, SlotTaken } from './acceptOffer';
import { setWindowIntent } from './windowIntent';
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
  await db.demand.deleteMany({ where: { raisedByUserId: ids.user } });
  // Capacity too: the slots derive from one window, so a test that fills the
  // seller's evening leaves the next one with nothing to sell.
  await db.vendorSlotCommitment.deleteMany({ where: { windowId: ids.window } });
});

after(async () => {
  if (!reachable) return;
  await db.demand.deleteMany({ where: { raisedByUserId: ids.user } });
  await db.planItem.deleteMany({ where: { planId: ids.plan } });
  await db.plan.deleteMany({ where: { id: ids.plan } });
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

  // Two separate guests, two separate demands, the same empty slot on a window
  // with room for six. Nothing here should be scarce.
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
