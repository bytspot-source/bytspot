import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmableNeedsFromParties, tonightWindow } from './conciergeSuggestions';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const TONIGHT = '2026-11-14T02:00:00.000Z';
const window = tonightWindow(NOW);

const party = (over: Partial<Parameters<typeof confirmableNeedsFromParties>[0][number]> = {}) => ({
  capability: 'book' as const, spacesRemaining: 4, hostCategory: 'music', hostType: null,
  startsAt: TONIGHT, endsAt: null, ...over,
});

test('Prime Path suggestions count only confirmable Bytspot supply inside tonight', () => {
  assert.deepEqual(confirmableNeedsFromParties([party()], window), ['events']);
  assert.deepEqual(confirmableNeedsFromParties([party({ hostType: 'club', hostCategory: 'nightlife' })], window), ['nightlife']);
  assert.deepEqual(confirmableNeedsFromParties([party({ hostType: 'dinner', hostCategory: 'food-drink' })], window), ['dining']);
  assert.deepEqual(confirmableNeedsFromParties([
    party({ capability: 'details' }),
    party({ spacesRemaining: 0 }),
    party({ hostType: 'yoga', hostCategory: 'outdoor' }),
    party({ startsAt: '2026-11-21T02:00:00.000Z' }),
    party({ startsAt: '2026-11-13T15:00:00.000Z', endsAt: '2026-11-13T18:00:00.000Z' }),
  ], window), []);
  const afternoon = tonightWindow(new Date('2026-11-13T19:00:00.000Z'));
  assert.ok(afternoon.startsAt.getTime() > new Date('2026-11-13T19:00:00.000Z').getTime());
  assert.deepEqual(confirmableNeedsFromParties([party()], afternoon), ['events']);
});
