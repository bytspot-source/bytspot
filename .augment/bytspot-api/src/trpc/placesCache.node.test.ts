import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedWithStale, locationBucket, mergeIncludedTypes, nearbySearchCacheKey, placesRouter, type StaleStore } from './placesRouter';
import { config } from '../config';
import { db } from '../lib/db';
import { rankRecommendations, type RecommendPlace, type RecommendVenue } from '../services/recommendations';

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

// ── Recommendations ─────────────────────────────────────

const HERE = { lat: 33.7866, lng: -84.3833 };

function place(over: Partial<RecommendPlace> & { placeId: string }): RecommendPlace {
  return {
    name: over.placeId, address: '1 Peachtree St', lat: HERE.lat + 0.002, lng: HERE.lng,
    rating: 4.6, ratingCount: 300, priceLevel: 'PRICE_LEVEL_MODERATE', types: ['restaurant'],
    primaryType: 'restaurant', photoUrls: [], photoAttributions: [], isOpen: true, websiteUri: null,
    ...over,
  };
}

function bytspotVenue(over: Partial<RecommendVenue> = {}): RecommendVenue {
  return {
    id: 'v1', slug: 'closers', name: 'Closers Coffee', address: '2 Peachtree St', lat: HERE.lat + 0.001, lng: HERE.lng,
    category: 'coffee', imageUrl: null, googlePlaceId: null, crowd: null, ...over,
  };
}

test('A coffee vibe recommends coffee shops, not the restaurant next door', () => {
  const r = rankRecommendations({ ...HERE, vibe: 'coffee' }, {
    cafe: [place({ placeId: 'cafe1', types: ['coffee_shop', 'cafe'], primaryType: 'coffee_shop' })],
    eat: [place({ placeId: 'rest1' })],
  }, []);
  assert.deepEqual(r.forYou.map((i) => i.id), ['gp:cafe1']);
  assert.equal(r.forYou[0].reasons[0], 'Fits coffee');
  assert.ok(r.forYou[0].reasons.includes('4.6★ · 300 reviews'));
});

test('Open, well-reviewed places outrank closed or thinly reviewed ones', () => {
  const r = rankRecommendations({ ...HERE, vibe: 'drinks' }, {
    drink: [
      place({ placeId: 'closed', types: ['bar'], primaryType: 'bar', isOpen: false }),
      place({ placeId: 'few', types: ['bar'], primaryType: 'bar', rating: 5, ratingCount: 3 }),
      place({ placeId: 'best', types: ['bar'], primaryType: 'bar', rating: 4.7, ratingCount: 900 }),
      place({ placeId: 'bad', types: ['bar'], primaryType: 'bar', rating: 3.1, ratingCount: 400 }),
    ],
  }, []);
  assert.deepEqual(r.forYou.map((i) => i.id), ['gp:best', 'gp:few', 'gp:closed']);
});

test('How far the guest will go limits what is recommended', () => {
  const far = place({ placeId: 'far', lat: HERE.lat + 0.012, types: ['coffee_shop'], primaryType: 'coffee_shop' });
  const near = place({ placeId: 'near', types: ['coffee_shop'], primaryType: 'coffee_shop' });
  assert.deepEqual(rankRecommendations({ ...HERE, vibe: 'coffee', walk: 'closest' }, { cafe: [far, near] }, []).forYou.map((i) => i.id), ['gp:near']);
  assert.equal(rankRecommendations({ ...HERE, vibe: 'coffee', walk: 'far' }, { cafe: [far, near] }, []).forYou.length, 2);
});

test('A Bytspot venue and its Google listing are one recommendation', () => {
  const r = rankRecommendations({ ...HERE, vibe: 'coffee' }, {
    cafe: [place({ placeId: 'gp-closers', name: 'Closers Coffee', lat: HERE.lat + 0.0011, types: ['coffee_shop'], primaryType: 'coffee_shop' })],
  }, [bytspotVenue({ crowd: { level: 1, label: 'Chill', source: 'typical' } })]);
  assert.equal(r.forYou.length, 1);
  assert.equal(r.forYou[0].kind, 'venue');
  assert.equal(r.forYou[0].slug, 'closers');
  assert.equal(r.forYou[0].placeId, 'gp-closers');
  assert.equal(r.forYou[0].rating, 4.6);
  // A catalog reading is never presented as live.
  assert.ok(r.forYou[0].reasons.includes('Usually chill now'));
});

test('Explore lists rated attractions and skips unrated or untyped listings', () => {
  const r = rankRecommendations({ ...HERE, vibe: 'food' }, {
    eat: [place({ placeId: 'rest1' })],
    explore: [
      place({ placeId: 'park', types: ['park'], primaryType: 'park', ratingCount: 2000 }),
      place({ placeId: 'tour', types: ['tourist_attraction'], primaryType: null, ratingCount: 40 }),
      place({ placeId: 'tiny', types: ['museum'], primaryType: 'museum', ratingCount: 4 }),
    ],
  }, []);
  assert.deepEqual(r.explore.map((i) => i.id), ['gp:park']);
  assert.ok(!r.explore[0].reasons.some((x) => x.startsWith('Fits')));
});

test('Recommendations share one Google search per pool and say when Google is down', async () => {
  const originalKey = config.googlePlacesApiKey;
  const originalFetch = globalThis.fetch;
  const venue = db.venue as unknown as { findMany: (args: unknown) => Promise<unknown[]> };
  const originalFindMany = venue.findMany;
  (config as { googlePlacesApiKey: string }).googlePlacesApiKey = 'test-key';
  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const isCafe = body.includedTypes.includes('coffee_shop');
    const places = isCafe ? [{ id: 'cafe1', displayName: { text: 'Cafe One' }, location: { latitude: 40.0012, longitude: -75.0 }, rating: 4.8, userRatingCount: 120, types: ['coffee_shop'], primaryType: 'coffee_shop', currentOpeningHours: { openNow: true } }] : [];
    return new Response(JSON.stringify({ places }), { status: 200 });
  }) as unknown as typeof fetch;
  venue.findMany = async () => [];
  try {
    const caller = placesRouter.createCaller({ user: null, clientRateLimitKey: 'test-recommend' } as never);
    const r = await caller.recommend({ lat: 40.0, lng: -75.0, vibe: 'coffee', walk: 'close', group: 'solo' });
    assert.equal(r.placesSource, 'google');
    assert.deepEqual(r.forYou.map((i) => i.name), ['Cafe One']);
    assert.ok(r.forYou[0].reasons.includes('Open now'));
    assert.deepEqual(bodies.map((b) => b.includedTypes.join(',')).sort(), ['art_gallery,museum,park,performing_arts_theater,tourist_attraction', 'bakery,cafe,coffee_shop']);
    assert.ok(bodies.every((b) => b.rankPreference === 'POPULARITY'));

    globalThis.fetch = (async () => new Response('denied', { status: 403 })) as typeof fetch;
    venue.findMany = async () => [{ ...bytspotVenue({ lat: 41.0001, lng: -75.0 }), crowdLevels: [] }];
    const down = await caller.recommend({ lat: 41.0, lng: -75.0, vibe: 'coffee' });
    assert.equal(down.placesSource, 'unavailable');
    assert.deepEqual(down.forYou.map((i) => i.slug), ['closers']);
  } finally {
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = originalKey;
    globalThis.fetch = originalFetch;
    venue.findMany = originalFindMany;
  }
});
