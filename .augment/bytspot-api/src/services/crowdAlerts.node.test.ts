import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Redis from 'ioredis';

import { claimPackedAlert } from './crowdTransition';
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

test('The packed alert is claimed once per venue, and fires when Redis is absent', async () => {
  const claims: string[] = [];
  const redis: Pick<Redis, 'set'> = {
    set: (async (key: string, _value: string, _ex: string, _ttl: number, mode: string) => {
      claims.push(`${key}:${mode}`);
      return claims.length === 1 ? 'OK' : null;
    }) as Redis['set'],
  };

  assert.equal(await claimPackedAlert('venue-1', 3600, redis), true);
  // The second entry into Packed inside the window stays quiet.
  assert.equal(await claimPackedAlert('venue-1', 3600, redis), false);
  assert.deepEqual(claims, ['alert:packed:venue-1:NX', 'alert:packed:venue-1:NX']);

  // No Redis must mean the alert still sends, not that it silently stops.
  assert.equal(await claimPackedAlert('venue-1', 3600, null), true);

  // Nor may a Redis failure silence it.
  const broken: Pick<Redis, 'set'> = { set: (async () => { throw new Error('down'); }) as Redis['set'] };
  assert.equal(await claimPackedAlert('venue-1', 3600, broken), true);
});
