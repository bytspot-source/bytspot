import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedWithStale, locationBucket, mergeIncludedTypes, nearbySearchCacheKey, placesRouter, type StaleStore } from './placesRouter';
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
    // Both search paths must agree; only nearbySearch was covered before.
    assert.equal((await caller.textSearch({ query: 'coffee midtown', maxResults: 10 })).source, 'none');
  } finally {
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = originalKey;
  }
});

/** Holds only the stale copy: the fresh key always misses, as after its TTL. */
function staleOnlyStore(): StaleStore & { seeded: number } {
  const entries = new Map<string, string>();
  return {
    get seeded() { return entries.size; },
    async get(key) { return key.endsWith(':stale') ? entries.get(key) ?? null : null; },
    async set(key, value) { entries.set(key, value); return 'OK'; },
  };
}

test('A week-old copy is served as stale, never as fresh truth', async () => {
  const store = staleOnlyStore();
  const seed = await cachedWithStale('probe', 900, async () => ['cafe'], store);
  assert.equal(seed.stale, false);
  assert.equal(store.seeded, 1);

  // Provider now fails and the fresh key has aged out: the surviving week-old
  // copy must come back flagged stale, not relabelled as a live result.
  const outage = await cachedWithStale('probe', 900, async () => { throw new Error('429'); }, store);
  assert.equal(outage.stale, true);
  assert.deepEqual(outage.data, ['cafe']);
});

test('With no stale copy the outage surfaces instead of inventing an answer', async () => {
  const store = staleOnlyStore();
  await assert.rejects(
    () => cachedWithStale('probe', 900, async () => { throw new Error('429'); }, store),
    /429/,
  );
});

test('The same coffee question in a different order is one cache entry, so one billed call', () => {
  // Coffee spans two Google types. Asking for them in either order is the
  // same question; a differing key would double the Places bill for it.
  const a = mergeIncludedTypes(undefined, ['coffee_shop', 'cafe']);
  const b = mergeIncludedTypes(undefined, ['cafe', 'coffee_shop']);
  assert.deepEqual(a, ['cafe', 'coffee_shop']);
  assert.deepEqual(a, b);
  assert.equal(
    nearbySearchCacheKey(33.7866, -84.3833, 2000, a, 10),
    nearbySearchCacheKey(33.7866, -84.3833, 2000, b, 10),
  );
  // A different set is a different question and must not collide.
  assert.notEqual(
    nearbySearchCacheKey(33.7866, -84.3833, 2000, a, 10),
    nearbySearchCacheKey(33.7866, -84.3833, 2000, mergeIncludedTypes('bar', undefined), 10),
  );
  // An unfiltered search keeps the key it had before types existed.
  assert.match(nearbySearchCacheKey(33.7866, -84.3833, 2000, [], 10), /:all:10$/);
});

test('The singular type is merged without asking Google for it twice', () => {
  assert.deepEqual(mergeIncludedTypes('night_club', undefined), ['night_club']);
  assert.deepEqual(mergeIncludedTypes('cafe', ['cafe', 'coffee_shop']), ['cafe', 'coffee_shop']);
  assert.deepEqual(mergeIncludedTypes(undefined, undefined), []);
});

test('The singular type still works and merges with types without duplicating', async () => {
  const originalKey = config.googlePlacesApiKey;
  const originalFetch = globalThis.fetch;
  (config as { googlePlacesApiKey: string }).googlePlacesApiKey = 'test-key';
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ places: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const caller = placesRouter.createCaller({ user: null, clientRateLimitKey: 'test-places' } as never);
    // Existing callers pass `type` alone and must be unaffected.
    await caller.nearbySearch({ lat: 34.0, lng: -84.0, radius: 2000, maxResults: 10, type: 'night_club' });
    assert.deepEqual(bodies[0].includedTypes, ['night_club']);

    // A caller sending both must not ask Google for the same type twice.
    await caller.nearbySearch({ lat: 34.1, lng: -84.0, radius: 2000, maxResults: 10, type: 'cafe', types: ['cafe', 'coffee_shop'] });
    assert.deepEqual(bodies[1].includedTypes, ['cafe', 'coffee_shop']);

    // Asking for nothing in particular still omits the filter entirely.
    await caller.nearbySearch({ lat: 34.2, lng: -84.0, radius: 2000, maxResults: 10 });
    assert.equal(bodies[2].includedTypes, undefined);
  } finally {
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});
