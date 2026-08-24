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
