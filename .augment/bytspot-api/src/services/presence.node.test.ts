import test from 'node:test';
import assert from 'node:assert/strict';

import { GLOBAL_FLOOR, resolveSummary } from './presence';

test('Circle presence outranks the global crowd whenever it has something to say', () => {
  assert.deepEqual(resolveSummary(3, 4000), { scope: 'circle', count: 3 });
  assert.deepEqual(resolveSummary(1, null), { scope: 'circle', count: 1 });
});

test('A global count below the floor is withheld rather than rounded up', () => {
  assert.deepEqual(resolveSummary(0, GLOBAL_FLOOR - 1), { scope: 'none' });
  assert.deepEqual(resolveSummary(0, 0), { scope: 'none' });
  assert.deepEqual(resolveSummary(0, GLOBAL_FLOOR), { scope: 'global', count: GLOBAL_FLOOR });
});

test('An unknowable global count is withheld, never reported as zero', () => {
  assert.deepEqual(resolveSummary(0, null), { scope: 'none' });
});
