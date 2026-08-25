import test from 'node:test';
import assert from 'node:assert/strict';
import { locationBucket } from './placesRouter';

test('Two callers on the same block share one Google search', () => {
  // ~40m apart: previously two cache keys, two paid calls.
  assert.equal(locationBucket(33.7866, -84.3833), locationBucket(33.7869, -84.3836));
});

test('A caller a few blocks away still gets local results', () => {
  // ~1km apart: must not collapse into the same bucket.
  assert.notEqual(locationBucket(33.7866, -84.3833), locationBucket(33.7956, -84.3833));
});

test('Buckets stay distinct across the sign boundary', () => {
  assert.notEqual(locationBucket(0.002, -84.3833), locationBucket(-0.002, -84.3833));
});
