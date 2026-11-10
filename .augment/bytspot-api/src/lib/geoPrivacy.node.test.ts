import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coarseCoordinate, COARSE_STEP_DEGREES } from './geoPrivacy';

test('coarse coordinates snap to the centre of a ~500 m cell and keep nulls', () => {
  assert.equal(coarseCoordinate(33.7866), 33.7875);
  assert.equal(coarseCoordinate(-84.3833), -84.3825);
  assert.equal(coarseCoordinate(null), null);
  // Two front doors in the same cell are indistinguishable.
  assert.equal(coarseCoordinate(33.7851), coarseCoordinate(33.7899));
  // Never more than half a cell away from the truth.
  for (const v of [0.0001, 12.3456789, -45.6789, 89.999]) assert.ok(Math.abs(coarseCoordinate(v) - v) <= COARSE_STEP_DEGREES / 2 + 1e-9);
});
