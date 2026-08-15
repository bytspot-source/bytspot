import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLiveOccupancySource } from './typicalOccupancy';

test('Packed alerts stay dark for catalog rows', () => {
  // runCrowdAlerts skips any latest CrowdLevel whose source is not live.
  // Keep this list in lockstep with typicalOccupancy.LIVE_OCCUPANCY_SOURCES.
  for (const source of ['typical', 'simulation', 'manual', '', undefined]) {
    assert.equal(isLiveOccupancySource(source), false, String(source));
  }
  for (const source of ['bytspot', 'user_report', 'sensor']) {
    assert.equal(isLiveOccupancySource(source), true, source);
  }
});
