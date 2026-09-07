import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidatesFromPlan, candidatesFromDiscovery, filterDiscoverableParties, capabilityForAccessMode, discoveredPartyCandidate, type PartyFacts, type PlanItemFacts, type DiscoverablePartyFacts } from './primePathCandidates';

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

// ─── B4c: Discovery candidate pool ─────────────────────────────────────────

function discoverableParty(overrides: Partial<DiscoverablePartyFacts> = {}): DiscoverablePartyFacts {
  return {
    id: 'party-d1', title: 'Midtown Rooftop', capacity: 60, status: 'published',
    admissionPaused: false, closedAt: null, endsAt: new Date('2026-09-08T02:00:00Z'),
    startsAt: new Date('2026-09-07T21:00:00Z'), accessMode: 'rsvp',
    requiredMembershipTier: 'green', audienceCircleIds: [],
    latitude: 33.79, longitude: -84.38, ...overrides,
  };
}

test('capabilityForAccessMode maps free/rsvp to request and paid-ticket to book', () => {
  assert.equal(capabilityForAccessMode('free'), 'request');
  assert.equal(capabilityForAccessMode('rsvp'), 'request');
  assert.equal(capabilityForAccessMode('paid-ticket'), 'book');
});

test('A discovered party candidate is marked discovered with ownInventory true', () => {
  const candidate = discoveredPartyCandidate(discoverableParty({ capacity: 50 }), 30, now);
  assert.equal(candidate.discovered, true);
  assert.equal(candidate.ownInventory, true);
  assert.equal(candidate.seats, 20);
  assert.equal(candidate.confirmableNow, true);
  assert.equal(candidate.capability, 'request');
  assert.ok(candidate.id.startsWith('discovered:'));
});

test('A discovered party past its end time is not confirmable', () => {
  const candidate = discoveredPartyCandidate(discoverableParty({ endsAt: new Date('2026-09-07T19:00:00Z') }), 0, now);
  assert.equal(candidate.confirmableNow, false);
});

test('filterDiscoverableParties gates on membership tier (Option B)', () => {
  const parties = [
    discoverableParty({ id: 'p-green', requiredMembershipTier: 'green' }),
    discoverableParty({ id: 'p-platinum', requiredMembershipTier: 'platinum' }),
    discoverableParty({ id: 'p-black', requiredMembershipTier: 'black' }),
  ];
  const greenUser = { userTier: 'green', userCircleIds: new Set<string>(), attachedPartyIds: new Set<string>() };
  assert.deepEqual(filterDiscoverableParties(parties, greenUser).map((p) => p.id), ['p-green']);
  const platUser = { ...greenUser, userTier: 'platinum' };
  assert.deepEqual(filterDiscoverableParties(parties, platUser).map((p) => p.id), ['p-green', 'p-platinum']);
  const blackUser = { ...greenUser, userTier: 'black' };
  assert.deepEqual(filterDiscoverableParties(parties, blackUser).map((p) => p.id), ['p-green', 'p-platinum', 'p-black']);
});

test('filterDiscoverableParties narrows by audience circles when non-empty', () => {
  const parties = [
    discoverableParty({ id: 'p-open', audienceCircleIds: [] }),
    discoverableParty({ id: 'p-circle', audienceCircleIds: ['circle-A', 'circle-B'] }),
  ];
  const noCircles = { userTier: 'green', userCircleIds: new Set<string>(), attachedPartyIds: new Set<string>() };
  assert.deepEqual(filterDiscoverableParties(parties, noCircles).map((p) => p.id), ['p-open']);
  const inCircleA = { ...noCircles, userCircleIds: new Set(['circle-A']) };
  assert.deepEqual(filterDiscoverableParties(parties, inCircleA).map((p) => p.id), ['p-open', 'p-circle']);
});

test('filterDiscoverableParties excludes already-attached party IDs', () => {
  const parties = [discoverableParty({ id: 'p-attached' }), discoverableParty({ id: 'p-new' })];
  const attached = { userTier: 'green', userCircleIds: new Set<string>(), attachedPartyIds: new Set(['p-attached']) };
  assert.deepEqual(filterDiscoverableParties(parties, attached).map((p) => p.id), ['p-new']);
});

test('candidatesFromDiscovery runs the full pipeline: filter + project', () => {
  const parties = [
    discoverableParty({ id: 'p-eligible', capacity: 30 }),
    discoverableParty({ id: 'p-gated', requiredMembershipTier: 'black' }),
    discoverableParty({ id: 'p-attached' }),
  ];
  const occ = new Map([['p-eligible', 10]]);
  const result = candidatesFromDiscovery(parties, occ, { userTier: 'green', userCircleIds: new Set(), attachedPartyIds: new Set(['p-attached']) }, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'discovered:p-eligible');
  assert.equal(result[0].seats, 20);
  assert.equal(result[0].discovered, true);
});
