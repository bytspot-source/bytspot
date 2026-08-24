import test from 'node:test';
import assert from 'node:assert/strict';

import { cellFor, cellName, GLOBAL_FLOOR, resolveSummary } from './presence';

test('The home count is the area a member is in, named only where we have a catalog', () => {
  const midtown = cellFor(33.7838, -84.383);
  assert.deepEqual(resolveSummary(4000, null, midtown), { scope: 'area', count: 4000, area: 'Midtown' });
  // Real cell, no catalog: the count stands, the place name does not.
  assert.deepEqual(resolveSummary(4000, null, cellFor(33.6403, -117.6031)), { scope: 'area', count: 4000, area: null });
});

test('A cell is a coarse grid, so neighbours share a room and distant places do not', () => {
  assert.equal(cellFor(33.7838, -84.383), cellFor(33.7901, -84.3805));
  assert.notEqual(cellFor(33.7838, -84.383), cellFor(33.8400, -84.383));
  assert.equal(cellName(null), null);
});

test('An area count below the floor is withheld rather than rounded up', () => {
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR - 1), { scope: 'none' });
  assert.deepEqual(resolveSummary(0), { scope: 'none' });
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR, null, cellFor(33.7838, -84.383)), { scope: 'area', count: GLOBAL_FLOOR, area: 'Midtown' });
});

test('An unknowable area count is withheld, never reported as zero', () => {
  assert.deepEqual(resolveSummary(null), { scope: 'none' });
});

test('Below the floor the row states accounts, which is a different claim', () => {
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR - 1, 64), { scope: 'members', count: 64 });
  assert.deepEqual(resolveSummary(null, 64), { scope: 'members', count: 64 });
  // Presence still outranks it: a measured crowd beats a registration total.
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR, 64), { scope: 'area', count: GLOBAL_FLOOR, area: null });
  assert.deepEqual(resolveSummary(null, 0), { scope: 'none' });
  assert.deepEqual(resolveSummary(null, null), { scope: 'none' });
});
