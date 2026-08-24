import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceMeters, FENCE_METERS, movesCrowdLevel, pointsFor, resolveProof } from './checkinProof';

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
