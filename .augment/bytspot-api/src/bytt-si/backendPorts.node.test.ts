import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConciergeSearch, PlacesOutcome } from '../services/conciergeDiscovery';
import type { RecommendPlace } from '../services/recommendations';
import { planFeasibility } from '../services/planFeasibility';
import { typicalLevel } from '../services/typicalOccupancy';
import { handoffUrl } from '../trpc/mobilityRouter';
import { createBackendBookablesPort } from './backend/bookables';
import { createBackendCrowdPort } from './backend/crowd';
import { atlantaLocalToIso, createBackendEventsPort, ticketmasterEventsNoFallback, type NearbyPartyRow } from './backend/events';
import { backendFinalCheck, proposalLegs } from './backend/finalCheck';
import { createBackendPeoplePort } from './backend/people';
import { createBackendPlacesPort } from './backend/places';
import { createBackendRoutingPort } from './backend/routing';
import { assertPartial, codes } from './testing/assert';
import { discoverBoth, FRIDAY_MESSAGE, fridayIntent, fridaySelection, NOW, setup } from './testing/helpers';
import type { ProposedPlan } from './types';

const place = (overrides: Partial<RecommendPlace> = {}): RecommendPlace => ({
  placeId: 'gp1', name: 'Real Place', address: '1 Peachtree St NE', lat: 33.7845, lng: -84.3838, rating: 4.4, ratingCount: 100,
  priceLevel: 'PRICE_LEVEL_MODERATE', types: ['restaurant'], primaryType: 'restaurant', photoUrls: [], photoAttributions: [], isOpen: true, websiteUri: null,
  ...overrides,
});
const query = { query: 'rooftop bar!!', needKind: 'drinks', latitude: 33.7838, longitude: -84.383, radiusMeters: 99_999 };

describe('bytt-si backend PlacesPort (conciergePlaces.ts)', () => {
  it('builds a valid conciergeSearch: rail from need, sanitized query, server-clamped radius', async () => {
    const seen: ConciergeSearch[] = [];
    const port = createBackendPlacesPort({ search: async (s) => { seen.push(s); return { places: [], source: 'none' }; }, reconcile: async () => ({ hiddenPlaceIds: [] }) });
    await port.search(query);
    assert.deepEqual(seen[0], { query: 'rooftop bar', rail: 'nightlife', mode: 'category', location: { lat: 33.7838, lng: -84.383 }, radius: 5000 });
    await port.search({ ...query, needKind: 'dining', query: '', radiusMeters: 10 });
    assertPartial(seen[1], { query: 'dining', rail: 'eat_drink', radius: 400 });
  });
  it('never turns a Google price level into a price; crowd is left to the CrowdPort', async () => {
    const port = createBackendPlacesPort({ search: async () => ({ places: [place()], source: 'google' }), reconcile: async () => ({ hiddenPlaceIds: [] }) });
    const out = await port.search(query);
    assertPartial(out, { source: 'google', places: [{ placeId: 'gp1', priceCents: null, priceBasis: null, crowd: null, isOpen: true, address: '1 Peachtree St NE' }] });
  });
  it('passes stale results through as stale (open/closed unknown)', async () => {
    const port = createBackendPlacesPort({ search: async () => ({ places: [place({ isOpen: null })], source: 'google-stale' }), reconcile: async () => ({ hiddenPlaceIds: [] }) });
    const out = await port.search(query);
    assert.equal(out.source, 'google-stale');
    assert.equal(out.places[0].isOpen, null);
  });
  it('drops places an admin hid from discovery', async () => {
    const port = createBackendPlacesPort({ search: async () => ({ places: [place(), place({ placeId: 'hidden', name: 'Hidden' })], source: 'google' }), reconcile: async () => ({ hiddenPlaceIds: ['hidden'] }) });
    assert.deepEqual((await port.search(query)).places.map((p) => p.placeId), ['gp1']);
  });
  it('is unavailable (empty) when search or reconciliation fails', async () => {
    const down = createBackendPlacesPort({ search: async () => { throw new Error('x'); }, reconcile: async () => ({ hiddenPlaceIds: [] }) });
    assert.deepEqual(await down.search(query), { places: [], source: 'unavailable' });
    const unverifiable = createBackendPlacesPort({ search: async (): Promise<PlacesOutcome> => ({ places: [place()], source: 'google' }), reconcile: async () => { throw new Error('db'); } });
    assert.deepEqual(await unverifiable.search(query), { places: [], source: 'unavailable' });
  });
});

const party = (overrides: Partial<NearbyPartyRow> = {}): NearbyPartyRow => ({
  id: 'p1', title: 'Late Set', venueName: 'Real Room', startsAt: '2026-11-07T03:00:00.000Z', endsAt: '2026-11-07T04:30:00.000Z',
  capability: 'book', locationHidden: false, latitude: 33.7818, longitude: -84.3825, capacity: 40, spacesRemaining: 12, ...overrides,
});
const eventsQuery = { latitude: 33.7838, longitude: -84.383, radiusMeters: 2414, startsAt: '2026-11-06T19:00:00-05:00', endsAt: '2026-11-06T23:59:00-05:00' };

describe('bytt-si backend EventsPort (eventsRouter.ts)', () => {
  it('maps Bytspot parties with selection id, capability and seats left; never a price', async () => {
    const seen: unknown[] = [];
    const port = createBackendEventsPort({ nearbyParties: async (q) => { seen.push(q); return [party()]; }, ticketmaster: async () => [] });
    const out = await port.search(eventsQuery);
    assertPartial(seen[0], { lat: 33.7838, lng: -84.383, radiusMiles: 1.5 });
    assert.equal(out.source, 'ok');
    assert.deepEqual(out.events, [{ id: 'p1', title: 'Late Set', venueName: 'Real Room', placeId: null, address: null, latitude: 33.7818, longitude: -84.3825,
      startsAt: '2026-11-07T03:00:00.000Z', endsAt: '2026-11-07T04:30:00.000Z', priceCents: null, capacity: 12, bookableId: 'party:p1', capability: 'book' }]);
  });
  it('drops parties whose location is withheld or outside the window', async () => {
    const port = createBackendEventsPort({ nearbyParties: async () => [party({ id: 'hidden', locationHidden: true, latitude: null, longitude: null }), party({ id: 'late', startsAt: '2026-11-08T03:00:00.000Z', endsAt: null })], ticketmaster: async () => [] });
    assert.deepEqual((await port.search(eventsQuery)).events, []);
  });
  it('returns empty — never the curated fallback — when every source fails', async () => {
    const port = createBackendEventsPort({ nearbyParties: async () => { throw new Error('rate limited'); }, ticketmaster: async () => { throw new Error('503'); } });
    assert.deepEqual(await port.search(eventsQuery), { events: [], source: 'unavailable' });
  });
  it('Ticketmaster without a key or with an HTTP error yields nothing, not fallback events', async () => {
    assert.deepEqual(await ticketmasterEventsNoFallback({ apiKey: '' }), []);
    const failing = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(() => ticketmasterEventsNoFallback({ apiKey: 'k', fetch: failing, cache: (_k, _t, f) => f() }));
  });
  it('maps located Ticketmaster events in the window and drops unlocated or TBD ones', async () => {
    const tm = [
      { id: 'tm1', title: 'Real Show', venue: 'Real Hall', address: '1 St', lat: 33.784, lng: -84.384, date: '2026-11-06', time: '20:00', url: 'https://www.ticketmaster.com/x' },
      { id: 'tm2', title: 'No Pin', venue: 'X', address: null, lat: null, lng: null, date: '2026-11-06', time: '20:00', url: '' },
      { id: 'tm3', title: 'TBD', venue: 'X', address: null, lat: 33.784, lng: -84.384, date: 'TBD', time: 'TBD', url: '' },
    ];
    const port = createBackendEventsPort({ nearbyParties: async () => [], ticketmaster: async () => tm });
    const out = await port.search(eventsQuery);
    assert.deepEqual(out.events.map((e) => [e.id, e.startsAt, e.priceCents, e.bookableId, e.capability]), [['tm:tm1', '2026-11-06T20:00:00-05:00', null, null, 'details']]);
  });
  it('converts Atlanta local date/time to an ISO instant across DST', () => {
    assert.equal(atlantaLocalToIso('2026-11-06', '20:00'), '2026-11-06T20:00:00-05:00');
    assert.equal(atlantaLocalToIso('2026-07-04', '21:30'), '2026-07-04T21:30:00-04:00');
    assert.equal(atlantaLocalToIso('TBD', 'TBD'), null);
  });
});

describe('bytt-si backend CrowdPort (typicalOccupancy.ts)', () => {
  it('returns Typical only, at the plan hour in Atlanta time', async () => {
    const port = createBackendCrowdPort();
    const reading = await port.typical({ placeId: 'gp1', name: 'Bar', types: ['bar'] }, '2026-11-07T03:00:00.000Z'); // Fri 10 PM ET
    assert.deepEqual(reading, { level: typicalLevel(22, 5, 'bar'), source: 'typical' });
  });
});

describe('bytt-si backend RoutingPort (planLegs / mobility deep links)', () => {
  it('estimates travel (never claims a provider) and builds hand-off links with mobilityRouter.handoffUrl', async () => {
    const port = createBackendRoutingPort();
    const est = await port.travel({ latitude: 33.7845, longitude: -84.3838 }, { latitude: 33.7818, longitude: -84.3825 }, 'walk');
    assertPartial(est, { basis: 'estimate' });
    assert.ok(est!.minutes > 0);
    const links = port.rideLinks!({ latitude: 33.78, longitude: -84.38, name: 'Real Room', address: null });
    assert.deepEqual(links.map((l) => l.url), [handoffUrl('uber', { lat: 33.78, lng: -84.38, name: 'Real Room', address: '' }), handoffUrl('lyft', { lat: 33.78, lng: -84.38, name: 'Real Room', address: '' })]);
  });
});

describe('bytt-si backend BookablesPort (tableBookingLinks.ts)', () => {
  it('refreshes the hand-checked links first, then returns the listed link for the place', async () => {
    const order: string[] = [];
    const port = createBackendBookablesPort({
      ensure: async () => { order.push('ensure'); },
      linkFor: (id) => { order.push(`linkFor:${id}`); return id === 'gp1' ? { provider: 'resy', label: 'Resy', url: 'https://resy.com/cities/atl/x' } : null; },
    });
    assert.deepEqual(await port.forPlace('gp1'), { bookables: [], tableLink: { provider: 'resy', label: 'Resy', url: 'https://resy.com/cities/atl/x' } });
    assert.deepEqual(await port.forPlace('other'), { bookables: [], tableLink: null });
    assert.deepEqual(order, ['ensure', 'linkFor:gp1', 'ensure', 'linkFor:other']);
  });
});

describe('bytt-si backend PeoplePort (social circles)', () => {
  const deps = {
    circleMembers: async () => [{ userId: 'u2', name: 'Ama Mensah' }, { userId: 'u3', name: 'Kofi' }, { userId: 'u4', name: 'Blocked Person' }, { userId: 'u5', name: null }],
    blocked: async () => new Set(['u4']),
  };
  it('matches named friends in the caller\'s circles, reports the rest, excludes blocked users and shares no preferences', async () => {
    const port = createBackendPeoplePort(deps);
    const out = await port.group('u1', ['ama', 'Yaw', 'Blocked Person']);
    assert.deepEqual(out, { members: [{ userId: 'u2', displayName: 'Ama Mensah', preferences: [] }], unresolved: ['Yaw', 'Blocked Person'] });
  });
  it('with no names returns the named circle members', async () => {
    const out = await createBackendPeoplePort(deps).group('u1', []);
    assert.deepEqual(out.members.map((m) => m.userId), ['u2', 'u3']);
  });
});

describe('bytt-si backend final check (planFeasibility.ts)', () => {
  async function fridayPlan(selection = fridaySelection()) {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [selection] }, chat: [discoverBoth] });
    return await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
  }
  it('turns proposal items into PlanLegs with the same facts', async () => {
    const plan = await fridayPlan();
    const legs = proposalLegs(plan);
    assertPartial(legs[0], { position: 0, needKind: 'dining', title: 'SAMPLE Southern Kitchen', durationMins: 90, priceCents: 3400, seats: null, latitude: 33.7845, longitude: -84.3838 });
    assert.equal(legs[0].startsAt!.toISOString(), '2026-11-07T00:00:00.000Z');
  });
  it('is the backend planFeasibility verdict, not a copy of it', async () => {
    const plan = await fridayPlan();
    const expected = planFeasibility(proposalLegs(plan), { startsAt: new Date(plan.startsAt!), endsAt: new Date(plan.endsAt!), partySize: 4, budgetCents: 24000 });
    const result = await backendFinalCheck(plan);
    assert.equal(result.verdict, expected.verdict);
    assert.deepEqual(result.checks.map((c) => [c.check, c.verdict]), expected.checks.map((c) => [c.check, c.verdict]));
  });
  it('breaks the budget check for an over-budget proposal', async () => {
    const plan = await fridayPlan();
    const result = await backendFinalCheck({ ...plan, budgetCents: 10000 });
    assert.equal(result.checks.find((c) => c.check === 'budget')!.verdict, 'breaks');
    assert.equal(result.verdict, 'breaks');
    assert.ok(codes(plan.notices).length >= 0);
  });
});
