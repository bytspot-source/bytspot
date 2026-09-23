import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legForItem, legsForPlan, minutesBetween, nextPosition, sequenceForAppend, type PlanLegSource } from './planLegs';

const at = (iso: string) => new Date(iso);

function source(overrides: Partial<PlanLegSource> = {}): PlanLegSource {
  return { id: 'item-1', position: 0, createdAt: at('2026-09-01T00:00:00Z'), needKind: 'dining', title: 'Table', ...overrides };
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
    offer: { startsAt: at('2026-10-01T20:00:00Z'), durationMins: 90, priceCents: 4500, capacity: 4, lat: 33.75, lng: -84.39 },
    party: { startsAt: at('2026-10-01T23:00:00Z'), endsAt: at('2026-10-02T02:00:00Z'), lat: 33.7726, lng: -84.3654, capacity: 20 },
  }));
  assert.deepEqual(leg.startsAt, at('2026-10-01T20:00:00Z'), 'the agreed time wins');
  assert.equal(leg.durationMins, 90);
  assert.equal(leg.priceCents, 4500, 'the agreed price wins over the snapshot');
  assert.equal(leg.latitude, 33.75);
});

test('free is zero and unknown is null, and they never collapse', () => {
  const free = { startsAt: at('2026-10-01T20:00:00Z'), durationMins: 60, priceCents: 0, capacity: 0 };
  assert.equal(legForItem(source({ offer: free })).priceCents, 0);
  assert.equal(legForItem(source()).priceCents, null);
  // Zero seats is a full room, which is a fact. Null is a supply that does not
  // count seats at all. A budget or capacity check must be able to tell these
  // apart, so neither is allowed to become the other.
  assert.equal(legForItem(source({ offer: free })).seats, 0);
  assert.equal(legForItem(source()).seats, null);
});

test('a party or coffee snapshot placeholder is never read as a price or a seat count', () => {
  // partyToBookableSnapshot writes priceCents 0 and capacity 0, and
  // coffeeToBookableSnapshot writes 0 or 1, because a Plan item attaches to a
  // room rather than a ticket tier and tier pricing is read live at booking
  // time. Those are placeholders for "not stated here". Reading them as facts
  // reports a paid party as free, which is the exact collapse this module
  // exists to prevent, so the snapshot is not consulted at all.
  const party = legForItem(source({
    party: { startsAt: at('2026-10-01T23:00:00Z'), endsAt: null, lat: null, lng: null, capacity: 20 },
  }));
  assert.equal(party.priceCents, null, 'a paid party must not be priced at zero');
  assert.equal(party.seats, 20, 'the party itself still states its seats');

  const coffee = legForItem(source({ needKind: 'coffee', coffeeSpot: { latitude: 33.79, longitude: -84.38 } }));
  assert.equal(coffee.priceCents, null);
  assert.equal(coffee.seats, null, 'coffee does not count seats, and must not claim zero or one');
});

test('seats come from the offer itself, not from the snapshot it wrote', () => {
  const leg = legForItem(source({
    offer: { startsAt: at('2026-10-01T20:00:00Z'), durationMins: 90, priceCents: 4500, capacity: 6 },
  }));
  assert.equal(leg.seats, 6);
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
  // Positions collide when two attaches race. createdAt decides first, then
  // id, which is the same tie-break plans.get reads items back with. If these
  // two disagree, feasibility judges a different evening from the one on
  // screen.
  const tied = legsForPlan([
    source({ id: 'z', position: 0, createdAt: at('2026-09-01T00:00:01Z') }),
    source({ id: 'y', position: 0, createdAt: at('2026-09-01T00:00:02Z') }),
  ]);
  assert.deepEqual(tied.map((leg) => leg.itemId), ['z', 'y'], 'createdAt breaks the tie before id does');

  const sameInstant = legsForPlan([
    source({ id: 'z', position: 0 }),
    source({ id: 'y', position: 0 }),
  ]);
  assert.deepEqual(sameInstant.map((leg) => leg.itemId), ['y', 'z'], 'id is the last resort');
});

test('an item with no stated position is lived last, not first', () => {
  // Only an instance still running the previous deploy writes one of these.
  // Sorting it first would displace items someone deliberately ordered.
  const legs = legsForPlan([
    source({ id: 'unplaced', position: null, title: 'Written mid-deploy', createdAt: at('2026-09-01T00:00:00Z') }),
    source({ id: 'a', position: 0, title: 'First', createdAt: at('2026-09-02T00:00:00Z') }),
    source({ id: 'b', position: 1, title: 'Second', createdAt: at('2026-09-03T00:00:00Z') }),
  ]);
  assert.deepEqual(legs.map((leg) => leg.title), ['First', 'Second', 'Written mid-deploy']);

  // Several of them keep their attach order among themselves.
  const many = legsForPlan([
    source({ id: 'q', position: null, title: 'Later', createdAt: at('2026-09-04T00:00:00Z') }),
    source({ id: 'p', position: null, title: 'Earlier', createdAt: at('2026-09-03T00:00:00Z') }),
  ]);
  assert.deepEqual(many.map((leg) => leg.title), ['Earlier', 'Later']);
});

test('an append settles the items a previous deploy left unpositioned instead of overtaking them', () => {
  // Left alone this never self-corrects: the appended item takes a finite
  // position, finite sorts before null, and the older item is overtaken for
  // good. So the write is the moment to settle it, into the slot readers were
  // already giving it, which makes the repair invisible.
  const { repairs, position } = sequenceForAppend([
    { id: 'placed', position: 0, createdAt: at('2026-09-01T00:00:00Z') },
    { id: 'orphan', position: null, createdAt: at('2026-09-02T00:00:00Z') },
  ]);
  assert.deepEqual(repairs, [{ id: 'orphan', position: 1 }]);
  assert.equal(position, 2, 'the new item goes after the item it would otherwise have overtaken');
});

test('several unpositioned items are settled in the order they were attached', () => {
  const { repairs, position } = sequenceForAppend([
    { id: 'b', position: null, createdAt: at('2026-09-03T00:00:00Z') },
    { id: 'a', position: null, createdAt: at('2026-09-02T00:00:00Z') },
    { id: 'placed', position: 4, createdAt: at('2026-09-01T00:00:00Z') },
  ]);
  assert.deepEqual(repairs, [{ id: 'a', position: 5 }, { id: 'b', position: 6 }]);
  assert.equal(position, 7);
});

test('a fully positioned Plan needs no repair', () => {
  const { repairs, position } = sequenceForAppend([
    { id: 'a', position: 0, createdAt: at('2026-09-01T00:00:00Z') },
    { id: 'b', position: 1, createdAt: at('2026-09-02T00:00:00Z') },
  ]);
  assert.deepEqual(repairs, []);
  assert.equal(position, 2);
});

test('an appended item goes after the sequence, and an unpositioned sibling is not counted as zero', () => {
  assert.equal(nextPosition([]), 0);
  assert.equal(nextPosition([{ position: 0 }, { position: 1 }]), 2);
  // A null sibling reading as 0 would hand the next item position 1 and leave
  // a gap; worse, it would treat an unstated position as a stated one.
  assert.equal(nextPosition([{ position: null }]), 0);
  assert.equal(nextPosition([{ position: 3 }, { position: null }]), 4);
});
