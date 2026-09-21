import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legForItem, legsForPlan, minutesBetween, type PlanLegSource } from './planLegs';

const at = (iso: string) => new Date(iso);

function source(overrides: Partial<PlanLegSource> = {}): PlanLegSource {
  return { id: 'item-1', position: 0, needKind: 'dining', title: 'Table', ...overrides };
}

test('a party states its time, place and seats', () => {
  const leg = legForItem(source({
    party: { startsAt: at('2026-10-01T23:00:00Z'), endsAt: at('2026-10-02T01:30:00Z'), lat: 33.7726, lng: -84.3654, capacity: 20 },
  }));
  assert.deepEqual(leg.startsAt, at('2026-10-01T23:00:00Z'));
  assert.equal(leg.durationMins, 150);
  assert.equal(leg.latitude, 33.7726);
  assert.equal(leg.seats, 20);
  // Nothing on a party states a price, so none is invented.
  assert.equal(leg.priceCents, null);
});

test('a party with no end has a start but no duration', () => {
  // The tempting default is "an hour". An hour is a guess, and a guess here
  // becomes a clash the guest never agreed to.
  const leg = legForItem(source({
    party: { startsAt: at('2026-10-01T23:00:00Z'), endsAt: null, lat: null, lng: null, capacity: null },
  }));
  assert.deepEqual(leg.startsAt, at('2026-10-01T23:00:00Z'));
  assert.equal(leg.durationMins, null);
});

test('an unreserved coffee spot is a place and nothing else', () => {
  const leg = legForItem(source({ needKind: 'coffee', coffeeSpot: { latitude: 33.79, longitude: -84.38 } }));
  assert.equal(leg.latitude, 33.79);
  assert.equal(leg.startsAt, null, 'coffee states no time and must not acquire one');
  assert.equal(leg.durationMins, null);
  assert.equal(leg.priceCents, null);
  assert.equal(leg.seats, null);
});

test('a reservation borrows the place of the spot it holds', () => {
  const leg = legForItem(source({ coffeeReservation: { coffeeSpot: { latitude: 33.78, longitude: -84.39 } } }));
  assert.equal(leg.latitude, 33.78);
  assert.equal(leg.longitude, -84.39);
  assert.equal(leg.startsAt, null, 'a hold window is not a start time');
});

test('a won offer outranks the projection behind it', () => {
  const leg = legForItem(source({
    offer: { startsAt: at('2026-10-01T20:00:00Z'), durationMins: 90, priceCents: 4500, lat: 33.75, lng: -84.39 },
    party: { startsAt: at('2026-10-01T23:00:00Z'), endsAt: at('2026-10-02T02:00:00Z'), lat: 33.7726, lng: -84.3654, capacity: 20 },
    bookable: { priceCents: 9999, capacity: 4 },
  }));
  assert.deepEqual(leg.startsAt, at('2026-10-01T20:00:00Z'), 'the agreed time wins');
  assert.equal(leg.durationMins, 90);
  assert.equal(leg.priceCents, 4500, 'the agreed price wins over the snapshot');
  assert.equal(leg.latitude, 33.75);
});

test('free is zero and unknown is null, and they never collapse', () => {
  assert.equal(legForItem(source({ bookable: { priceCents: 0, capacity: 0 } })).priceCents, 0);
  assert.equal(legForItem(source({ bookable: { priceCents: null, capacity: null } })).priceCents, null);
  // Zero seats is a full room, which is a fact. Null is a supply that does not
  // count seats at all. A budget or capacity check must be able to tell these
  // apart, so neither is allowed to become the other.
  assert.equal(legForItem(source({ bookable: { priceCents: 0, capacity: 0 } })).seats, 0);
  assert.equal(legForItem(source()).seats, null);
});

test('half a coordinate, 0/0 and off-Earth values are not places', () => {
  const place = (lat: number | null, lng: number | null) =>
    legForItem(source({ coffeeSpot: { latitude: lat, longitude: lng } }));
  assert.equal(place(33.79, null).latitude, null, 'half a coordinate is not a location');
  assert.equal(place(null, -84.38).longitude, null);
  assert.equal(place(0, 0).latitude, null, '0/0 is the shape of an unset pair, not the Atlantic');
  assert.equal(place(91, -84.38).latitude, null);
  assert.equal(place(33.79, 181).longitude, null);
  assert.equal(place(Number.NaN, -84.38).latitude, null);
});

test('an item pointing at nothing is all unknowns, never zeros', () => {
  const leg = legForItem(source({ needKind: 'nightlife', title: 'Somewhere later' }));
  assert.deepEqual(
    { s: leg.startsAt, d: leg.durationMins, la: leg.latitude, lo: leg.longitude, p: leg.priceCents, se: leg.seats },
    { s: null, d: null, la: null, lo: null, p: null, se: null },
  );
  assert.equal(leg.title, 'Somewhere later', 'the item still names itself so a refusal can point at it');
});

test('a backwards or zero-length party pair is unknown, not negative', () => {
  // Arithmetic on a negative duration silently buys back time elsewhere in the
  // sequence, so a contradiction is reported as unstated instead.
  assert.equal(minutesBetween(at('2026-10-01T23:00:00Z'), at('2026-10-01T21:00:00Z')), null);
  assert.equal(minutesBetween(at('2026-10-01T23:00:00Z'), at('2026-10-01T23:00:00Z')), null);
  assert.equal(minutesBetween(null, at('2026-10-01T23:00:00Z')), null);
  assert.equal(minutesBetween(at('2026-10-01T23:00:00Z'), null), null);
});

test('legs come back in the order the Plan states, and ties are still total', () => {
  const legs = legsForPlan([
    source({ id: 'c', position: 2, title: 'Third' }),
    source({ id: 'a', position: 0, title: 'First' }),
    source({ id: 'b', position: 1, title: 'Second' }),
  ]);
  assert.deepEqual(legs.map((leg) => leg.title), ['First', 'Second', 'Third']);

  // Positions can collide when two attaches race. The order must still be
  // decided by something, or two reads of one Plan disagree.
  const tied = legsForPlan([source({ id: 'z', position: 0 }), source({ id: 'y', position: 0 })]);
  assert.deepEqual(tied.map((leg) => leg.itemId), ['y', 'z']);
});
