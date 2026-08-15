import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dayPartCategory,
  isLiveOccupancySource,
  typicalCrowd,
  typicalJitter,
  typicalLevel,
  TYPICAL_SOURCE,
  MIDTOWN_DAY_PART_VENUES,
} from './typicalOccupancy';

test('day-part categories do not collapse to nightlife', () => {
  assert.equal(dayPartCategory('Coffee Shop'), 'coffee');
  assert.equal(dayPartCategory('golf'), 'golf');
  assert.equal(dayPartCategory('boutique fitness studio'), 'fitness');
  assert.equal(dayPartCategory('cowork workspace'), 'workspace');
  assert.equal(dayPartCategory('unknown loft'), 'venue');
});

test('Tuesday morning is coffee/fitness, not Friday night', () => {
  const tuesday = 2;
  assert.ok(typicalLevel(8, tuesday, 'coffee') >= 3, 'coffee peaks at 8am');
  assert.ok(typicalLevel(7, tuesday, 'fitness') >= 3, 'gym peaks at 7am');
  assert.equal(typicalLevel(8, tuesday, 'club'), 1);
  assert.equal(typicalLevel(8, tuesday, 'bar'), 1);
  assert.ok(typicalLevel(8, tuesday, 'golf') >= 2);
  assert.ok(typicalLevel(10, tuesday, 'workspace') >= 3);
});

test('unknown pins get a midday hum, not a 10pm default', () => {
  assert.equal(typicalLevel(22, 5, 'mystery-loft'), 1);
  assert.ok(typicalLevel(12, 3, 'mystery-loft') >= 2);
});

test('typical rows are never live sources', () => {
  const crowd = typicalCrowd(8, 2, 'coffee');
  assert.equal(crowd.source, TYPICAL_SOURCE);
  assert.equal(isLiveOccupancySource(crowd.source), false);
  assert.equal(isLiveOccupancySource('user_report'), true);
  assert.equal(isLiveOccupancySource('bytspot'), true);
  assert.equal(isLiveOccupancySource('simulation'), false);
});

test('jitter is deterministic for the same venue/hour', () => {
  const a = typicalJitter(3, 'octane-coffee-midtown', 8, 2);
  const b = typicalJitter(3, 'octane-coffee-midtown', 8, 2);
  assert.equal(a, b);
});

test('day-part Midtown catalog covers arrival hours', () => {
  const kinds = new Set(MIDTOWN_DAY_PART_VENUES.map((v) => v.category));
  for (const need of ['coffee', 'golf', 'fitness', 'workspace'] as const) {
    assert.ok(kinds.has(need), `missing ${need}`);
  }
});
