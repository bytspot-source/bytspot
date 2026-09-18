import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMAND_DEFAULTS } from './demand';
import { constraintsFromPlan, demandCategoryForNeed, refusalMessage, type EmissionRefusal } from './planDemand';

const NOW = new Date('2026-09-18T18:00:00Z');

const plan = (over: Partial<Parameters<typeof constraintsFromPlan>[0]> = {}) => ({
  startsAt: new Date('2026-09-18T23:00:00Z'),
  endsAt: new Date('2026-09-19T02:00:00Z'),
  latitude: 33.7866,
  longitude: -84.3833,
  partySize: 4,
  ...over,
});

const item = (over: Partial<Parameters<typeof constraintsFromPlan>[1]> = {}) => ({
  needKind: 'dining',
  status: 'available',
  bookableId: null,
  ...over,
});

function refusal(result: ReturnType<typeof constraintsFromPlan>): EmissionRefusal {
  assert.equal(result.ok, false);
  return (result as { ok: false; reason: EmissionRefusal }).reason;
}

test('a plan that says enough asks for exactly what it says', () => {
  const result = constraintsFromPlan(plan(), item(), NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.envelope, {
    category: 'dining',
    partySize: 4,
    earliest: new Date('2026-09-18T23:00:00Z'),
    latest: new Date('2026-09-19T02:00:00Z'),
    latitude: 33.7866,
    longitude: -84.3833,
  });
});

test('only the categories that mean the same thing in both vocabularies map', () => {
  assert.equal(demandCategoryForNeed('coffee'), 'coffee');
  assert.equal(demandCategoryForNeed('events'), 'entertainment');
  assert.equal(demandCategoryForNeed('stay'), 'boutique_apartment');

  // Ambiguous on purpose. `automotive` could be parking, valet or a service,
  // and `wellness` could be fitness or a service: choosing would publish to the
  // wrong sellers and read as Bytspot having misunderstood the guest.
  assert.equal(demandCategoryForNeed('automotive'), undefined);
  assert.equal(demandCategoryForNeed('wellness'), undefined);
  // No demand category exists for these at all.
  assert.equal(demandCategoryForNeed('green'), undefined);
  assert.equal(demandCategoryForNeed('stall'), undefined);
  assert.equal(demandCategoryForNeed('not-a-need'), undefined);
});

test('a plan with a start but no end is read at the flexibility the contract already allows', () => {
  const result = constraintsFromPlan(plan({ endsAt: null }), item(), NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ok && result.envelope.latest,
    new Date(new Date('2026-09-18T23:00:00Z').getTime() + DEMAND_DEFAULTS.flexibilityMins * 60_000),
  );
});

test('a plan already under way asks from now, not from a time that has gone', () => {
  const started = plan({
    startsAt: new Date('2026-09-18T17:00:00Z'),
    endsAt: new Date('2026-09-18T21:00:00Z'),
  });
  const result = constraintsFromPlan(started, item(), NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.envelope.earliest, NOW);
});

test('a need already met is not asked for again', () => {
  assert.equal(refusal(constraintsFromPlan(plan(), item({ bookableId: 'bkbl-1' }), NOW)), 'item-filled');
  assert.equal(refusal(constraintsFromPlan(plan(), item({ status: 'cancelled' }), NOW)), 'item-cancelled');
});

test('a plan that does not say enough is refused with the reason, never guessed', () => {
  assert.equal(refusal(constraintsFromPlan(plan({ startsAt: null }), item(), NOW)), 'no-window');
  assert.equal(
    refusal(constraintsFromPlan(plan({ latitude: null, longitude: null }), item(), NOW)),
    'no-location',
  );
  // A failed geolocation is not a place the plan is happening.
  assert.equal(refusal(constraintsFromPlan(plan({ latitude: 0, longitude: 0 }), item(), NOW)), 'no-location');
  assert.equal(refusal(constraintsFromPlan(plan(), item({ needKind: 'automotive' }), NOW)), 'category-unmappable');

  // Not defaulted to one. Capacity is a match rule, so a guessed party size
  // returns offers that cannot seat the group.
  assert.equal(refusal(constraintsFromPlan(plan({ partySize: null }), item(), NOW)), 'no-party-size');
  assert.equal(refusal(constraintsFromPlan(plan({ partySize: 0 }), item(), NOW)), 'no-party-size');
});

test('a plan whose window has passed cannot be asked about', () => {
  const over = plan({
    startsAt: new Date('2026-09-18T10:00:00Z'),
    endsAt: new Date('2026-09-18T12:00:00Z'),
  });
  assert.equal(refusal(constraintsFromPlan(over, item(), NOW)), 'window-passed');
});

test('a party larger than demand allows is clamped rather than refused', () => {
  // The guest still has a real need; it is the request that has a ceiling.
  const result = constraintsFromPlan(plan({ partySize: 500 }), item(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.envelope.partySize, DEMAND_DEFAULTS.maxPartySize);
});

test('every refusal can be said out loud to a guest', () => {
  const reasons: EmissionRefusal[] = [
    'item-cancelled',
    'item-filled',
    'category-unmappable',
    'no-window',
    'window-passed',
    'no-location',
    'no-party-size',
  ];
  for (const reason of reasons) {
    const said = refusalMessage(reason);
    assert.ok(said.length > 0, `${reason} needs a message`);
    // A reason is a thing to fix, not a code to look up.
    assert.ok(!said.includes('-'), `${reason} leaks its identifier`);
  }
});
