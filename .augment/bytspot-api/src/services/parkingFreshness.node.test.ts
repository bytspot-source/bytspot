import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARKING_STALE_AFTER_MS, venueParking, type ParkingSpotRow } from './parkingFreshness';

const now = new Date('2026-11-02T20:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const row = (over: Partial<ParkingSpotRow> = {}): ParkingSpotRow => ({
  name: 'Deck A', type: 'garage', available: 12, totalSpots: 40, pricePerHr: 6, updatedAt: ago(60_000), ...over,
});

test('a venue with no parking rows is unknown, with no count', () => {
  assert.deepEqual(venueParking([], now), { freshness: 'unknown', asOf: null, totalAvailable: 0, spots: [] });
});

test('recent rows are live and carry their counts', () => {
  const parking = venueParking([row(), row({ name: 'Lot B', available: 3, updatedAt: ago(5 * 60_000) })], now);
  assert.equal(parking.freshness, 'live');
  assert.equal(parking.totalAvailable, 15);
  assert.deepEqual(parking.spots.map((s) => s.available), [12, 3]);
  assert.equal(parking.asOf, ago(5 * 60_000).toISOString());
});

test('one old row makes the venue stale and withholds every count', () => {
  const parking = venueParking([row(), row({ name: 'Lot B', updatedAt: ago(PARKING_STALE_AFTER_MS + 1) })], now);
  assert.equal(parking.freshness, 'stale');
  assert.equal(parking.totalAvailable, 0);
  assert.deepEqual(parking.spots.map((s) => s.available), [null, null]);
  assert.deepEqual(parking.spots.map((s) => s.total), [40, 40]);
  assert.equal(parking.asOf, ago(PARKING_STALE_AFTER_MS + 1).toISOString());
});

test('a row exactly at the limit is still live', () => {
  assert.equal(venueParking([row({ updatedAt: ago(PARKING_STALE_AFTER_MS) })], now).freshness, 'live');
});

test('update times read back from the JSON cache as strings', () => {
  const parking = venueParking([row({ updatedAt: ago(60_000).toISOString() })], now);
  assert.equal(parking.freshness, 'live');
  assert.equal(parking.totalAvailable, 12);
});

test('an unreadable update time is stale, never live', () => {
  const parking = venueParking([row({ updatedAt: 'not a date' })], now);
  assert.equal(parking.freshness, 'stale');
  assert.equal(parking.asOf, null);
  assert.equal(parking.totalAvailable, 0);
});
