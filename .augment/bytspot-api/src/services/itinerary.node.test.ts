import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildItinerary, STOP_BUFFER_MINS, type ItineraryStopInput, type OpeningPeriod, type TimeSource } from './itinerary';
import type { PlanLeg } from './planLegs';

// 2026-10-02 is a Friday. 22:00Z is 6:00 PM in Atlanta (EDT, UTC-4).
const at = (iso: string) => new Date(iso);
const SIX_PM = at('2026-10-02T22:00:00Z');
const MIDNIGHT = at('2026-10-03T04:00:00Z');

const A = { latitude: 33.7810, longitude: -84.3860 };
const NEAR_A = { latitude: 33.7820, longitude: -84.3870 };
const B = { latitude: 33.8480, longitude: -84.3730 };

let seq = 0;
function stop(leg: Partial<PlanLeg> = {}, extra: { timeSource?: TimeSource | null; hours?: OpeningPeriod[] | null } = {}): ItineraryStopInput {
  seq += 1;
  return {
    leg: {
      itemId: `item-${seq}`, position: seq, needKind: 'dining', title: `Stop ${seq}`,
      startsAt: null, durationMins: null, latitude: null, longitude: null, priceCents: null, seats: null,
      ...leg,
    },
    timeSource: extra.timeSource ?? null,
    hours: extra.hours ?? null,
  };
}

/** Friday, opening and closing in Atlanta time. */
const friday = (open: [number, number], close: [number, number], closeDay = 5): OpeningPeriod[] =>
  [{ open: { day: 5, hour: open[0], minute: open[1] }, close: { day: closeDay, hour: close[0], minute: close[1] } }];

const plan = { startsAt: SIX_PM, endsAt: MIDNIGHT };

test('stops are timed in the person\'s order, with estimated lengths labelled', () => {
  const first = stop({ needKind: 'dining', ...A });
  const second = stop({ needKind: 'nightlife', ...NEAR_A });
  const result = buildItinerary([first, second], plan);

  assert.equal(result.status, 'timed');
  const [dinner, club] = result.stops;
  assert.deepEqual(dinner.arriveAt, SIX_PM);
  assert.equal(dinner.time, 'estimated');
  assert.equal(dinner.length, 'estimated');
  assert.equal(dinner.lengthMins, 90);
  assert.ok(club.travel && club.travel.atLeastMins >= 1);
  assert.deepEqual(club.arriveAt, new Date(SIX_PM.getTime() + (90 + club.travel!.atLeastMins + STOP_BUFFER_MINS) * 60_000));
  assert.equal(club.lengthMins, 120);
});

test('a set time stays put and is labelled with who set it', () => {
  const booked = stop({ startsAt: at('2026-10-03T00:30:00Z'), durationMins: 60, ...A }, { timeSource: 'offer' });
  const [only] = buildItinerary([booked], plan).stops;
  assert.deepEqual(only.arriveAt, at('2026-10-03T00:30:00Z'));
  assert.equal(only.time, 'set');
  assert.equal(only.timeSource, 'offer');
  assert.equal(only.length, 'stated');
});

test('a set time before the previous stop could end is called out', () => {
  const dinner = stop({ ...A });
  const show = stop({ startsAt: at('2026-10-02T23:00:00Z'), durationMins: 60, ...NEAR_A }, { timeSource: 'party' });
  const [, party] = buildItinerary([dinner, show], plan).stops;
  assert.match(party.issues.join(' '), /before you'd finish Stop/);
});

test('a stop that opens later is placed at opening, with the wait shown', () => {
  const bar = stop({ needKind: 'nightlife', ...A }, { hours: friday([19, 0], [2, 0], 6) });
  const [only] = buildItinerary([bar], plan).stops;
  assert.deepEqual(only.arriveAt, at('2026-10-02T23:00:00Z'), 'opens at 7 PM');
  assert.equal(only.waitMins, 60);
  assert.equal(only.hours, 'known');
  assert.deepEqual(only.issues, []);
});

test('a stop that closes before the estimated length ends says when', () => {
  const cafe = stop({ needKind: 'dining', ...A }, { hours: friday([7, 0], [19, 0]) });
  const [only] = buildItinerary([cafe], plan).stops;
  assert.deepEqual(only.issues, ['Closes at 7:00 PM.']);
});

test('a stop closed all evening is flagged, not silently moved', () => {
  const lunch = stop({ ...A }, { hours: friday([11, 0], [15, 0]) });
  const [only] = buildItinerary([lunch], plan).stops;
  assert.deepEqual(only.arriveAt, SIX_PM);
  assert.deepEqual(only.issues, ['Closed at 6:00 PM.']);
});

test('open 24 hours never waits or warns', () => {
  const diner = stop({ ...A }, { hours: [{ open: { day: 0, hour: 0, minute: 0 } }] });
  const [only] = buildItinerary([diner], plan).stops;
  assert.equal(only.waitMins, 0);
  assert.deepEqual(only.issues, []);
});

test('hours past Saturday midnight still read as open', () => {
  // Opens Saturday 10 PM, closes Sunday 2 AM: wraps the week boundary.
  const late = stop({ needKind: 'nightlife', ...A },
    { hours: [{ open: { day: 6, hour: 22, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } }] });
  // Sunday 1 AM Atlanta.
  const sunday = { startsAt: at('2026-10-04T05:00:00Z'), endsAt: at('2026-10-04T07:00:00Z') };
  const [only] = buildItinerary([late], sunday).stops;
  assert.deepEqual(only.arriveAt, sunday.startsAt);
  assert.deepEqual(only.issues, ['Closes at 2:00 AM.']);
});

test('running past the Plan\'s end is called out', () => {
  const late = { startsAt: at('2026-10-03T03:00:00Z'), endsAt: MIDNIGHT };
  const [only] = buildItinerary([stop({ needKind: 'nightlife', ...A })], late).stops;
  assert.match(only.issues.join(' '), /Runs past your Plan's end at 12:00 AM/);
});

test('without a Plan start or a set first time, the timeline asks for a start', () => {
  const result = buildItinerary([stop({ ...A }), stop({ ...B })], { startsAt: null, endsAt: null });
  assert.equal(result.status, 'needsStart');
  assert.equal(result.stops[0].arriveAt, null);
  assert.equal(result.stops[0].time, null);
});

test('a set first time anchors a Plan with no start', () => {
  const booked = stop({ startsAt: SIX_PM, ...A }, { timeSource: 'guestBooking' });
  const result = buildItinerary([booked, stop({ ...NEAR_A })], { startsAt: null, endsAt: null });
  assert.equal(result.status, 'timed');
  assert.ok(result.stops[1].arriveAt);
});

test('a stop with no place says travel is not counted', () => {
  const [, unplaced] = buildItinerary([stop({ ...A }), stop({})], plan).stops;
  assert.equal(unplaced.travel, null);
  assert.match(unplaced.issues[0], /No location yet/);
});

test('parking is listed as skipped, not timed', () => {
  const result = buildItinerary([stop({ ...A }), stop({ needKind: 'parking', title: 'Garage' })], plan);
  assert.equal(result.stops.length, 1);
  assert.deepEqual(result.skipped.map((entry) => entry.title), ['Garage']);
});

test('a clearly shorter order is suggested, the person\'s order is kept', () => {
  // A → B → near A doubles back ~7.5 km each way.
  const first = stop({ ...A });
  const far = stop({ ...B });
  const back = stop({ ...NEAR_A });
  const result = buildItinerary([first, far, back], plan);
  assert.deepEqual(result.stops.map((entry) => entry.itemId), [first.leg.itemId, far.leg.itemId, back.leg.itemId]);
  assert.ok(result.suggestedOrder);
  assert.ok(result.suggestedOrder.savesMeters > 5_000);
  const order = result.suggestedOrder.itemIds;
  assert.equal(Math.abs(order.indexOf(first.leg.itemId) - order.indexOf(back.leg.itemId)), 1, 'the two nearby stops sit together');
});

test('no suggestion when a shorter order breaks a set time or adds waiting', () => {
  const first = stop({ ...A });
  // Set at 7:45 PM. Putting the nearby stops together either runs into it or
  // leaves the group waiting for it.
  const far = stop({ startsAt: at('2026-10-02T23:45:00Z'), durationMins: 60, ...B }, { timeSource: 'party' });
  const back = stop({ ...NEAR_A });
  assert.equal(buildItinerary([first, far, back], plan).suggestedOrder, null);
});

test('no suggestion when the saving is small', () => {
  const result = buildItinerary([stop({ ...A }), stop({ ...NEAR_A }), stop({ latitude: 33.7815, longitude: -84.3865 })], plan);
  assert.equal(result.suggestedOrder, null);
});

test('an empty Plan has no timeline', () => {
  assert.equal(buildItinerary([], plan).status, 'empty');
});
