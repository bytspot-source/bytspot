import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidatesFromPlan, type PartyFacts, type PlanItemFacts } from './primePathCandidates';

const now = new Date('2026-09-07T20:00:00Z');
const ctx = { partySize: 4 };

function partyItem(overrides: Partial<PlanItemFacts> = {}): PlanItemFacts {
  return { id: 'item-p', title: 'The Basement', status: 'available', capability: 'book', partyId: 'party-1', coffeeReservationId: null, coffeeReservation: null, ...overrides };
}
function coffeeItem(overrides: Partial<PlanItemFacts> = {}): PlanItemFacts {
  return { id: 'item-c', title: 'Highland Bakery', status: 'available', capability: 'request', partyId: null, coffeeReservationId: 'r-1', coffeeReservation: { status: 'pending', holdExpiresAt: new Date('2026-09-07T21:00:00Z') }, ...overrides };
}
function party(overrides: Partial<PartyFacts> = {}): PartyFacts {
  return { id: 'party-1', capacity: 40, status: 'published', admissionPaused: false, closedAt: null, endsAt: new Date('2026-09-08T02:00:00Z'), ...overrides };
}

test('A party candidate carries Live seats — capacity minus granted guests', () => {
  const [candidate] = candidatesFromPlan([partyItem()], new Map([['party-1', party({ capacity: 40 })]]), new Map([['party-1', 36]]), ctx, now);
  assert.equal(candidate.seats, 4);
  assert.equal(candidate.confirmableNow, true);
  assert.equal(candidate.ownInventory, true);
  assert.equal(candidate.capability, 'book');
});

test('A closed, paused, expired, or full room is not confirmable', () => {
  const map = (p: Partial<PartyFacts>, granted = 0) => candidatesFromPlan([partyItem()], new Map([['party-1', party(p)]]), new Map([['party-1', granted]]), ctx, now)[0].confirmableNow;
  assert.equal(map({ closedAt: new Date() }), false);
  assert.equal(map({ admissionPaused: true }), false);
  assert.equal(map({ status: 'draft' }), false);
  assert.equal(map({ endsAt: new Date('2026-09-07T19:00:00Z') }), false);
  assert.equal(map({ capacity: 40 }, 40), false); // full
});

test('A party deleted out from under the item is simply not confirmable', () => {
  const [candidate] = candidatesFromPlan([partyItem()], new Map(), new Map(), ctx, now);
  assert.equal(candidate.seats, 0);
  assert.equal(candidate.confirmableNow, false);
});

test('A coffee hold is confirmable while live and covers the party without asserting seats', () => {
  const [live] = candidatesFromPlan([coffeeItem()], new Map(), new Map(), ctx, now);
  assert.equal(live.confirmableNow, true);
  assert.equal(live.seats, ctx.partySize);
  assert.equal(live.capability, 'request');
  // An expired or withdrawn hold is not confirmable.
  const expired = candidatesFromPlan([coffeeItem({ coffeeReservation: { status: 'expired', holdExpiresAt: null } })], new Map(), new Map(), ctx, now)[0];
  assert.equal(expired.confirmableNow, false);
  const stale = candidatesFromPlan([coffeeItem({ coffeeReservation: { status: 'pending', holdExpiresAt: new Date('2026-09-07T19:00:00Z') } })], new Map(), new Map(), ctx, now)[0];
  assert.equal(stale.confirmableNow, false);
});

test('Cancelled items and pure references produce no candidate', () => {
  const items: PlanItemFacts[] = [
    partyItem({ id: 'x', status: 'cancelled' }),
    { id: 'ref', title: 'Piedmont Park', status: 'available', capability: 'details', partyId: null, coffeeReservationId: null, coffeeReservation: null },
  ];
  assert.deepEqual(candidatesFromPlan(items, new Map(), new Map(), ctx, now), []);
});

test('Sort inputs with no server data are neutral, not invented', () => {
  const [candidate] = candidatesFromPlan([partyItem()], new Map([['party-1', party()]]), new Map([['party-1', 0]]), ctx, now);
  assert.equal(candidate.travelMinutes, null);
  assert.equal(candidate.reliability, 0);
  assert.equal(candidate.continuationValue, 0);
  assert.equal(candidate.startLabel, null);
});
