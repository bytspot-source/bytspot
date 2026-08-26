import test from 'node:test';
import assert from 'node:assert/strict';
import { locationBucket, placesRouter } from './placesRouter';
import { config } from '../config';

test('Two callers on the same block share one Google search', () => {
  // ~40m apart: previously two cache keys, two paid calls.
  assert.equal(locationBucket(33.7866, -84.3833), locationBucket(33.7869, -84.3836));
});

test('A caller a few blocks away still gets local results', () => {
  // ~1km apart: must not collapse into the same bucket.
  assert.notEqual(locationBucket(33.7866, -84.3833), locationBucket(33.7956, -84.3833));
});

test('Buckets stay distinct across the sign boundary', () => {
  assert.notEqual(locationBucket(0.002, -84.3833), locationBucket(-0.002, -84.3833));
});

test('Google failing empties the list honestly instead of erroring the tab', async () => {
  const originalKey = config.googlePlacesApiKey;
  const originalFetch = globalThis.fetch;
  // A rejected key (the 403 seen in production) must not surface as a 500.
  (config as { googlePlacesApiKey: string }).googlePlacesApiKey = 'test-key';
  globalThis.fetch = (async () => new Response('denied', { status: 403 })) as typeof fetch;
  try {
    const caller = placesRouter.createCaller({ user: null, clientRateLimitKey: 'test-places' } as never);
    const nearby = await caller.nearbySearch({ lat: 33.7866, lng: -84.3833, radius: 2000, maxResults: 10 });
    assert.deepEqual(nearby, { places: [], source: 'unavailable' });

    const text = await caller.textSearch({ query: 'coffee midtown', maxResults: 10 });
    assert.deepEqual(text, { places: [], source: 'unavailable' });
  } finally {
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test('An unconfigured key stays distinct from an unreachable provider', async () => {
  const originalKey = config.googlePlacesApiKey;
  (config as { googlePlacesApiKey: string }).googlePlacesApiKey = '';
  try {
    const caller = placesRouter.createCaller({ user: null, clientRateLimitKey: 'test-places' } as never);
    // 'none' means never asked; 'unavailable' means asked and could not reach.
    assert.equal((await caller.nearbySearch({ lat: 33.7866, lng: -84.3833, radius: 2000, maxResults: 10 })).source, 'none');
  } finally {
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = originalKey;
  }
});
