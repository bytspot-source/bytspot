import test from 'node:test';
import assert from 'node:assert/strict';

import { DAILY_POINT_CEILING, FENCE_METERS, crowdLevelForVisitors, distanceMeters, movesCrowdLevel, pointsFor, resolvePayout, resolveProof } from './checkinProof';

const venue = { lat: 33.7866, lng: -84.3833 };

test('A tap with no coordinate proves nothing and is recorded as such', () => {
  assert.deepEqual(resolveProof(null, venue), { proof: 'self_reported', distanceMeters: null });
  // A venue we have no coordinate for cannot fence anyone, and says so rather
  // than passing the check-in by default.
  assert.deepEqual(resolveProof(venue, { lat: null, lng: null }), { proof: 'self_reported', distanceMeters: null });
});

test('Inside the fence is evidence; outside it is a claim, and the distance is kept either way', () => {
  const inside = resolveProof({ lat: 33.7868, lng: -84.3835 }, venue);
  assert.equal(inside.proof, 'nearby');
  assert.ok(inside.distanceMeters !== null && inside.distanceMeters < FENCE_METERS);

  // Half a kilometre away: recorded, with the distance, and not believed.
  const outside = resolveProof({ lat: 33.7911, lng: -84.3833 }, venue);
  assert.equal(outside.proof, 'self_reported');
  assert.ok(outside.distanceMeters !== null && outside.distanceMeters > FENCE_METERS);
});

test('A scanned code outranks distance, because standing there is the proof', () => {
  assert.deepEqual(resolveProof(null, venue, true), { proof: 'verified', distanceMeters: null });
});

test('Points and crowd level are paid only for check-ins that cost something', () => {
  assert.equal(pointsFor('self_reported'), 0);
  assert.equal(pointsFor('nearby'), 10);
  assert.equal(pointsFor('verified'), 10);
  assert.equal(movesCrowdLevel('self_reported'), false);
  assert.equal(movesCrowdLevel('nearby'), true);
});

test('Distance is symmetric and zero at the venue itself', () => {
  assert.equal(distanceMeters(venue, venue), 0);
  const a = { lat: 33.79, lng: -84.39 };
  assert.equal(distanceMeters(venue, a), distanceMeters(a, venue));
});

test('One visit pays once, however many times the member taps', () => {
  const now = new Date('2026-08-24T22:00:00Z');
  const paid = resolvePayout({ proof: 'nearby', lastPaidVisitAt: null, pointsEarnedToday: 0, now });
  assert.deepEqual(paid, { points: 10, reason: 'paid' });

  // Standing in the room and tapping again is the same visit, not a second one.
  const again = resolvePayout({ proof: 'nearby', lastPaidVisitAt: new Date('2026-08-24T21:30:00Z'), pointsEarnedToday: 10, now });
  assert.deepEqual(again, { points: 0, reason: 'same_visit' });

  // Coming back the next night is a new visit.
  const tomorrow = resolvePayout({ proof: 'nearby', lastPaidVisitAt: new Date('2026-08-23T22:00:00Z'), pointsEarnedToday: 0, now });
  assert.deepEqual(tomorrow, { points: 10, reason: 'paid' });
});

test('The daily ceiling refuses the last points rather than the whole check-in', () => {
  const now = new Date('2026-08-24T22:00:00Z');
  const full = resolvePayout({ proof: 'nearby', lastPaidVisitAt: null, pointsEarnedToday: DAILY_POINT_CEILING, now });
  assert.deepEqual(full, { points: 0, reason: 'daily_ceiling' });

  // Five points short of the ceiling pays five, not ten and not nothing.
  const partial = resolvePayout({ proof: 'nearby', lastPaidVisitAt: null, pointsEarnedToday: DAILY_POINT_CEILING - 5, now });
  assert.deepEqual(partial, { points: 5, reason: 'paid' });

  // Proof is checked before either limit, so an unproven tap says so.
  const unproven = resolvePayout({ proof: 'self_reported', lastPaidVisitAt: null, pointsEarnedToday: DAILY_POINT_CEILING, now });
  assert.deepEqual(unproven, { points: 0, reason: 'unproven' });
});

test('Crowd level counts people, so one member cannot report a packed room', () => {
  assert.equal(crowdLevelForVisitors(1), 1);
  assert.equal(crowdLevelForVisitors(2), 2);
  assert.equal(crowdLevelForVisitors(4), 3);
  assert.equal(crowdLevelForVisitors(8), 4);
  assert.equal(crowdLevelForVisitors(40), 4);
  // An empty hour is Chill, not an error.
  assert.equal(crowdLevelForVisitors(0), 1);
});
