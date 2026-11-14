import assert from 'node:assert/strict';
import test from 'node:test';
import { areaTimeZone, clearAreaTimeZoneCache, LAUNCH_TIME_ZONE } from './areaTimeZone';

test('a Plan near Atlanta keeps Eastern time without a lookup; elsewhere the zone is looked up once per cell', async () => {
  clearAreaTimeZoneCache();
  const asked: Array<[number, number]> = [];
  const lookup = async (lat: number, lng: number) => { asked.push([lat, lng]); return 'America/Los_Angeles'; };
  assert.equal(await areaTimeZone({ lat: 33.749, lng: -84.388 }, lookup), LAUNCH_TIME_ZONE);
  assert.deepEqual(asked, []);
  assert.equal(await areaTimeZone({ lat: 34.0522, lng: -118.2437 }, lookup), 'America/Los_Angeles');
  assert.equal(await areaTimeZone({ lat: 34.0531, lng: -118.2441 }, lookup), 'America/Los_Angeles');
  assert.equal(asked.length, 1, 'the same ~10 km cell is not asked twice');
});

test('no location, a failed or empty lookup gives null, never a guessed zone', async () => {
  clearAreaTimeZoneCache();
  assert.equal(await areaTimeZone(null), null);
  assert.equal(await areaTimeZone({ lat: null, lng: null }), null);
  assert.equal(await areaTimeZone({ lat: 25.76, lng: -80.19 }, async () => { throw new Error('down'); }), null);
  assert.equal(await areaTimeZone({ lat: 25.76, lng: -80.19 }, async () => undefined), null);
  assert.equal(await areaTimeZone({ lat: 25.76, lng: -80.19 }, async () => 'America/New_York'), 'America/New_York', 'a failure is not cached');
});
