import test from 'node:test';
import assert from 'node:assert/strict';

import { GLOBAL_FLOOR, resolveSummary } from './presence';

test('The home count is the whole app, not the people a member knows', () => {
  assert.deepEqual(resolveSummary(4000), { scope: 'global', count: 4000 });
});

test('A global count below the floor is withheld rather than rounded up', () => {
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR - 1), { scope: 'none' });
  assert.deepEqual(resolveSummary(0), { scope: 'none' });
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR), { scope: 'global', count: GLOBAL_FLOOR });
});

test('An unknowable global count is withheld, never reported as zero', () => {
  assert.deepEqual(resolveSummary(null), { scope: 'none' });
});

test('Below the floor the row states accounts, which is a different claim', () => {
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR - 1, 64), { scope: 'members', count: 64 });
  assert.deepEqual(resolveSummary(null, 64), { scope: 'members', count: 64 });
  // Presence still outranks it: a measured crowd beats a registration total.
  assert.deepEqual(resolveSummary(GLOBAL_FLOOR, 64), { scope: 'global', count: GLOBAL_FLOOR });
  assert.deepEqual(resolveSummary(null, 0), { scope: 'none' });
  assert.deepEqual(resolveSummary(null, null), { scope: 'none' });
});
