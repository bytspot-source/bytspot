import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guestTravelLine, TRAVEL_TIME_UNAVAILABLE } from './travelCopy';

test('a straight-line travel estimate is never a bare minute count', () => {
  assert.equal(guestTravelLine(12, 'estimate'), 'about 12 min (estimate)');
  assert.equal(guestTravelLine(1, 'estimate'), 'about 1 min (estimate)');
  assert.doesNotMatch(guestTravelLine(12, 'estimate'), /^\d+ min$/);
});

test('a client MapKit drive is labeled an Apple Maps estimate', () => {
  assert.equal(guestTravelLine(12, 'apple_maps'), 'about 12 min (Apple Maps estimate)');
});

test('a missing travel time has one sentence and no duration', () => {
  assert.equal(TRAVEL_TIME_UNAVAILABLE, 'Travel time unavailable.');
  assert.doesNotMatch(TRAVEL_TIME_UNAVAILABLE, /\d/);
});
