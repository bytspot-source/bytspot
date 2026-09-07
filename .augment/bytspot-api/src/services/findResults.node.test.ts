import assert from 'node:assert/strict';
import test from 'node:test';

import { indexedVenueToFindResult, mergeFindResults, resolvedPlaceToFindResult, type IndexedVenue, type ResolvedPlace } from './findResults';
import { placesRouter } from '../trpc/placesRouter';
import { config } from '../config';
import { db } from '../lib/db';

const venue = db.venue as unknown as { findMany: (args: unknown) => Promise<unknown[]> };

function indexedVenue(over: Partial<IndexedVenue> = {}): IndexedVenue {
  return { id: 'v1', name: 'The Basement', slug: 'the-basement', googlePlaceId: 'gp-A', address: '123 Edgewood', lat: 33.75, lng: -84.37, category: 'club', imageUrl: null, ...over };
}
function resolvedPlace(over: Partial<ResolvedPlace> = {}): ResolvedPlace {
  return { placeId: 'gp-B', name: 'Highland Bakery', address: '644 N Highland', lat: 33.77, lng: -84.35, primaryType: 'bakery', photoUrls: ['https://img/1'], ...over };
}
function caller() {
  return placesRouter.createCaller({ user: null, clientRateLimitKey: 'test-find' } as never);
}

test('An indexed venue keeps its slug and is DETAILS', () => {
  const r = indexedVenueToFindResult(indexedVenue());
  assert.equal(r.origin, 'index');
  assert.equal(r.slug, 'the-basement');
  assert.equal(r.capability, 'details');
});

test('A resolved-only place is a gp handle, slugless, and always DETAILS', () => {
  const r = resolvedPlaceToFindResult(resolvedPlace());
  assert.equal(r.origin, 'resolved');
  assert.equal(r.id, 'gp:gp-B');
  assert.equal(r.slug, null);
  assert.equal(r.googlePlaceId, 'gp-B');
  assert.equal(r.imageUrl, 'https://img/1');
  assert.equal(r.capability, 'details'); // the lock: no branch can make it bookable
});

test('Index leads and our own copy wins a duplicate', () => {
  const indexed = [indexedVenueToFindResult(indexedVenue({ googlePlaceId: 'gp-A' }))];
  const resolved = [
    resolvedPlaceToFindResult(resolvedPlace({ placeId: 'gp-A' })), // duplicate of the indexed venue
    resolvedPlaceToFindResult(resolvedPlace({ placeId: 'gp-B' })),
  ];
  const merged = mergeFindResults(indexed, resolved, 10);
  assert.deepEqual(merged.map((r) => r.id), ['v1', 'gp:gp-B']);
  assert.equal(merged[0].origin, 'index');
});

test('The merged page never exceeds the limit, index first', () => {
  const indexed = [indexedVenueToFindResult(indexedVenue({ id: 'v1', googlePlaceId: null }))];
  const resolved = [resolvedPlaceToFindResult(resolvedPlace({ placeId: 'gp-B' })), resolvedPlaceToFindResult(resolvedPlace({ placeId: 'gp-C' }))];
  const merged = mergeFindResults(indexed, resolved, 2);
  assert.deepEqual(merged.map((r) => r.id), ['v1', 'gp:gp-B']);
});

test('places.find leads with the index and does not resolve externally when the page is full', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('no external call expected'); }) as typeof fetch;
  venue.findMany = async () => [indexedVenue({ id: 'v1', name: 'Basement', slug: 'basement' }), indexedVenue({ id: 'v2', name: 'Basement Two', slug: 'basement-two', googlePlaceId: null })];
  try {
    const result = await caller().find({ query: 'basement', maxResults: 2 });
    assert.deepEqual(result.results.map((r) => r.id), ['v1', 'v2']);
    assert.equal(result.source, 'index');
    assert.equal(result.provider, null); // a full index page never reaches the provider
    assert.ok(result.results.every((r) => r.origin === 'index' && r.capability === 'details'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('places.find degrades honestly when the index is short and the provider is unconfigured', async () => {
  const originalKey = config.googlePlacesApiKey;
  const originalFetch = globalThis.fetch;
  (config as { googlePlacesApiKey: string | undefined }).googlePlacesApiKey = undefined;
  globalThis.fetch = (async () => { throw new Error('no external call expected'); }) as typeof fetch;
  venue.findMany = async () => [indexedVenue()];
  try {
    const result = await caller().find({ query: 'the basement', maxResults: 10 });
    assert.deepEqual(result.results.map((r) => r.id), ['v1']);
    assert.equal(result.source, 'index');
    assert.equal(result.provider, 'none'); // short page tried the provider, which is unconfigured
  } finally {
    (config as { googlePlacesApiKey: string | undefined }).googlePlacesApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});
