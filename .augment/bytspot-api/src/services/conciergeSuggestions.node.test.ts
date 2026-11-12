import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmableNeedsFromParties } from './conciergeSuggestions';

const party = (over: Partial<Parameters<typeof confirmableNeedsFromParties>[0][number]> = {}) => ({
  capability: 'book' as const, spacesRemaining: 4, hostCategory: 'music', hostType: null, ...over,
});

test('Prime Path suggestions count only confirmable Bytspot supply, by its real category', () => {
  assert.deepEqual(confirmableNeedsFromParties([party()]), ['events']);
  assert.deepEqual(confirmableNeedsFromParties([party({ hostType: 'club', hostCategory: 'nightlife' })]), ['nightlife']);
  assert.deepEqual(confirmableNeedsFromParties([party({ hostType: 'dinner', hostCategory: 'food-drink' })]), ['dining']);
  assert.deepEqual(confirmableNeedsFromParties([
    party({ capability: 'details' }),
    party({ spacesRemaining: 0 }),
    party({ hostType: 'yoga', hostCategory: 'outdoor' }),
  ]), []);
});
