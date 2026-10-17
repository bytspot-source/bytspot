import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../lib/db';
import { config } from '../config';
import { cachedWithStale, gpPost } from '../trpc/placesRouter';
import { conciergeVenues } from './conciergeDiscoveryAdapters';
import { planConcierge, type ConciergeSearch } from './conciergeDiscovery';
import { conciergePlacesCacheKey, createConciergePlacesSearch, discoveryBounds, type ConciergePlacesDependencies } from './conciergePlaces';

const search: ConciergeSearch = planConcierge({ location: { lat: 40, lng: -75 }, messages: [{ role: 'user', content: 'coffee' }] }).search;
const directCache: typeof cachedWithStale = async (_key, _ttl, fetcher) => ({ data: await fetcher(), stale: false });
const rawPlace = { id: 'real-place', displayName: { text: 'Coffee One' }, formattedAddress: '1 Test Street',
  location: { latitude: 40.001, longitude: -75 }, primaryType: 'coffee_shop', currentOpeningHours: { openNow: true } };
function provider(over: Partial<ConciergePlacesDependencies> = {}) {
  return createConciergePlacesSearch({ enabled: () => true, cache: directCache, post: async () => ({ places: [rawPlace] }), ...over });
}

test('cache isolation includes query, exact location and radius, but no raw query', () => {
  const key = conciergePlacesCacheKey(search);
  assert.notEqual(key, conciergePlacesCacheKey({ ...search, location: { lat: 41, lng: -75 } }));
  assert.notEqual(key, conciergePlacesCacheKey({ ...search, location: { lat: 40, lng: -74 } }));
  assert.notEqual(key, conciergePlacesCacheKey({ ...search, radius: 800 }));
  assert.notEqual(key, conciergePlacesCacheKey({ ...search, query: 'pizza' }));
  assert.notEqual(key, conciergePlacesCacheKey({ ...search, mode: 'name' }));
  assert.equal(key, conciergePlacesCacheKey({ ...search, query: ' Coffee ' }));
  assert.equal(key.includes('coffee'), false);
});

test('provider uses one restricted text search with real coordinates and text-only fields', async () => {
  let calls = 0;
  const discover = provider({ post: async (body, fields) => {
    calls++;
    const request = body as { textQuery: string; maxResultCount: number; locationRestriction: { rectangle: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } } }; locationBias?: unknown };
    assert.equal(request.textQuery, 'coffee');
    assert.equal(request.maxResultCount, 20);
    assert.equal(request.locationBias, undefined);
    const { low, high } = request.locationRestriction.rectangle;
    assert.ok(low.latitude < 40 && high.latitude > 40);
    assert.ok(low.longitude < -75 && high.longitude > -75);
    assert.ok(high.latitude - low.latitude < 0.04);
    assert.doesNotMatch(fields, /photos|reviews|websiteUri/);
    return { places: [rawPlace] };
  } });
  const response = await discover(search);
  assert.equal(calls, 1);
  assert.equal(response.source, 'google');
  assert.equal(response.places[0].placeId, 'real-place');
  assert.deepEqual(response.places[0].photoUrls, []);
});

test('named search uses location bias but still rejects distant branches', async () => {
  const response = await provider({ post: async (body) => {
    const request = body as Record<string, unknown>;
    assert.equal(request.locationRestriction, undefined);
    assert.deepEqual(request.locationBias, { circle: { center: { latitude: 40, longitude: -75 }, radius: search.radius } });
    return { places: [rawPlace, { ...rawPlace, id: 'far-branch', location: { latitude: 41, longitude: -75 } }] };
  } })({ ...search, query: 'Coffee One', mode: 'name' });
  assert.deepEqual(response.places.map((p) => p.placeId), ['real-place']);
});

test('provider discards distant, missing and invalid coordinates before mapping', async () => {
  const response = await provider({ post: async () => ({ places: [
    rawPlace, { ...rawPlace, id: 'distant', location: { latitude: 45, longitude: -75 } },
    { id: 'missing', displayName: { text: 'Missing' } },
    { ...rawPlace, id: 'invalid', location: { latitude: 91, longitude: -75 } },
    { ...rawPlace, id: 'bad-rating', rating: 'five' },
  ] }) })(search);
  assert.deepEqual(response.places.map((p) => p.placeId), ['real-place']);
});

test('unconfigured, failed, empty and stale provider outcomes remain distinct', async () => {
  let calls = 0;
  const absent = await provider({ enabled: () => false, post: async () => { calls++; return {}; } })(search);
  assert.equal(absent.source, 'none');
  assert.equal(calls, 0);
  const down = await provider({ post: async () => { throw new Error('Do not log this response'); } })(search);
  assert.deepEqual(down, { places: [], source: 'unavailable' });
  const empty = await provider({ post: async () => ({ places: [] }) })(search);
  assert.deepEqual(empty, { places: [], source: 'google' });
  const malformed = await provider({ post: async () => ({ places: [{ id: 'missing-location' }] }) })(search);
  assert.deepEqual(malformed, { places: [], source: 'unavailable' });
  const staleCache: typeof cachedWithStale = async (_key, _ttl, fetcher) => ({ data: await fetcher(), stale: true });
  const stale = await provider({ cache: staleCache })(search);
  assert.equal(stale.source, 'google-stale');
  assert.equal(stale.places[0].isOpen, null);
});

test('invalid search parameters cannot reach a provider or cache', async () => {
  const discover = provider({ enabled: () => { assert.fail('validation must run first'); } });
  await assert.rejects(() => discover({ ...search, radius: 50000 }));
  await assert.rejects(() => discover({ ...search, location: { lat: NaN, lng: 0 } }));
});

test('geographic rectangles support the date line and poles without a city bias', () => {
  const crossing = discoveryBounds({ lat: 0, lng: 179.999 }, 2000);
  assert.ok(crossing.lowLng > crossing.highLng);
  const pole = discoveryBounds({ lat: 89.999, lng: 100 }, 2000);
  assert.equal(pole.highLat, 90);
  assert.equal(pole.lowLng, -180);
  assert.equal(pole.highLng, 180);
});

test('catalog query is bounded, discoverable-only, parameterized and excludes photos/crowd', async () => {
  const delegate = db.venue as unknown as { findMany: (args: unknown) => Promise<unknown[]> };
  const original = delegate.findMany;
  let args: any;
  delegate.findMany = async (request) => { args = request; return []; };
  try {
    assert.deepEqual(await conciergeVenues(search), []);
    assert.equal(args.where.discoverable, true);
    assert.ok(args.where.lat.gte < 40 && args.where.lat.lte > 40);
    assert.equal(args.take, 200);
    assert.equal(args.select.imageUrl, undefined);
    assert.equal(args.select.crowdLevels, undefined);
    assert.equal(args.where.AND[1].OR[0].category.equals, 'coffee');
    await conciergeVenues({ ...search, mode: 'name', query: "Joe's Coffee" });
    assert.deepEqual(args.where.AND[1].OR, [{ name: { contains: "Joe's Coffee", mode: 'insensitive' } }]);
    await conciergeVenues({ ...search, location: { lat: 0, lng: 179.999 } });
    assert.equal(args.where.AND[0].OR.length, 2);
  } finally { delegate.findMany = original; }
});

test('shared Google transport enforces a deadline and does not log response bodies', async () => {
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const previousKey = config.googlePlacesApiKey;
  const logs: string[] = [];
  (config as { googlePlacesApiKey: string }).googlePlacesApiKey = 'test-only';
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response('private-provider-response-body', { status: 403 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => gpPost('/places:searchText', {}, 'places.id'), /403/);
    assert.deepEqual(logs, ['[places] Google request failed (403)']);
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = previousKey;
  }
});
