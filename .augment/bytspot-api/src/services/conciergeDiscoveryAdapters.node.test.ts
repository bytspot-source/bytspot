import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../lib/db';
import { conciergeReconcilePlaces, conciergeVenues } from './conciergeDiscoveryAdapters';
import type { ConciergeSearch } from './conciergeDiscovery';
import type { RecommendPlace, RecommendVenue } from './recommendations';

const delegate = db.venue as unknown as { findMany: (args: unknown) => Promise<unknown[]> };
const search: ConciergeSearch = { query: 'dumplings', mode: 'category', rail: 'eat_drink', location: { lat: 40, lng: -75 }, radius: 2000 };
function place(placeId: string): RecommendPlace {
  return { placeId, name: 'Dumplings nearby', address: '1 Test Street', lat: 40, lng: -75,
    rating: null, ratingCount: 0, priceLevel: null, types: ['restaurant'], primaryType: 'restaurant',
    photoUrls: [], photoAttributions: [], isOpen: null, websiteUri: null };
}
function row(over: Partial<Omit<RecommendVenue, 'imageUrl' | 'crowd'> & { discoverable: boolean }> = {}) {
  return { id: 'canonical-venue', slug: 'golden-house', name: 'Golden House', address: '1 Test Street',
    lat: 40, lng: -75, category: 'restaurant', googlePlaceId: 'visible-google', discoverable: true, ...over };
}

// Match the existing adapter-test convention: restore the Prisma delegate even on failure.
async function withFindMany(stub: typeof delegate.findMany, run: () => Promise<void>) {
  const original = delegate.findMany;
  delegate.findMany = stub;
  try { await run(); } finally { delegate.findMany = original; }
}

test('reconciliation looks up visible and hidden Google identities across the entire catalog', async () => {
  let calls = 0;
  await withFindMany(async (request) => {
    calls++;
    assert.deepEqual(request, {
      where: { googlePlaceId: { in: ['visible-google', 'places/visible-google', 'hidden-google', 'places/hidden-google'] } },
      select: { id: true, slug: true, name: true, address: true, lat: true, lng: true, category: true, googlePlaceId: true, discoverable: true },
    });
    return [row(), row({ id: 'hidden-venue', googlePlaceId: 'places/hidden-google', discoverable: false })];
  }, async () => {
    const result = await conciergeReconcilePlaces([place('places/visible-google'), place('hidden-google'), place('visible-google')]);
    assert.equal(calls, 1);
    assert.deepEqual(result.hiddenPlaceIds, ['hidden-google']);
    assert.deepEqual(result.venues, [{ id: 'canonical-venue', slug: 'golden-house', name: 'Golden House',
      address: '1 Test Street', lat: 40, lng: -75, category: 'restaurant', googlePlaceId: 'visible-google', imageUrl: null, crowd: null }]);
  });
});

test('a canonical venue is recovered by ID even when its name does not match dumplings', async () => {
  let calls = 0;
  await withFindMany(async (request) => {
    calls++;
    const args = request as { where: { googlePlaceId?: { in: string[] }; AND?: unknown[] } };
    if (args.where.AND) return []; // The ordinary text search cannot find Golden House.
    assert.deepEqual(args.where, { googlePlaceId: { in: ['visible-google', 'places/visible-google'] } });
    return [row({ googlePlaceId: 'places/visible-google' })];
  }, async () => {
    assert.deepEqual(await conciergeVenues(search), []);
    const result = await conciergeReconcilePlaces([place('visible-google')]);
    assert.equal(calls, 2);
    assert.equal(result.venues[0].id, 'canonical-venue');
    assert.equal(result.venues[0].googlePlaceId, 'visible-google');
    assert.doesNotMatch(result.venues[0].name, /dumplings/i);
  });
});

test('empty or invalid identities do not access the database', async () => {
  await withFindMany(async () => { assert.fail('no database lookup expected'); }, async () => {
    assert.deepEqual(await conciergeReconcilePlaces([]), { venues: [], hiddenPlaceIds: [] });
    assert.deepEqual(await conciergeReconcilePlaces([place(''), place('https://invalid.test'), place('places/'), place('bad id')]),
      { venues: [], hiddenPlaceIds: [] });
  });
});

test('reconciliation validates and deduplicates at most twenty identities without truncating', async () => {
  let calls = 0;
  await withFindMany(async (request) => {
    calls++;
    const args = request as { where: { googlePlaceId: { in: string[] } } };
    assert.equal(args.where.googlePlaceId.in.length, 40); // Twenty identities, two storage forms each.
    assert.ok(args.where.googlePlaceId.in.every((id) => /^(?:places\/)?google-\d+$/.test(id)));
    return [];
  }, async () => {
    const places = Array.from({ length: 20 }, (_, index) => place(`google-${index}`));
    await conciergeReconcilePlaces([...places, place('places/google-0'), place('invalid/id')]);
    assert.equal(calls, 1);
    await assert.rejects(() => conciergeReconcilePlaces([...places, place('google-20')]), RangeError);
    assert.equal(calls, 1);
  });
});

test('lookup failures propagate so the caller can drop Google results', async () => {
  const failure = new Error('lookup unavailable');
  await withFindMany(async () => { throw failure; }, async () => {
    await assert.rejects(() => conciergeReconcilePlaces([place('visible-google')]), (error) => error === failure);
  });
});

test('hidden identities are never emitted as venues, even with a visible duplicate storage form', async () => {
  await withFindMany(async () => [row(), row({ id: 'hidden', googlePlaceId: 'places/visible-google', discoverable: false }),
    row({ id: 'hidden-duplicate', discoverable: false })], async () => {
    assert.deepEqual(await conciergeReconcilePlaces([place('visible-google')]), { venues: [], hiddenPlaceIds: ['visible-google'] });
  });
});

test('generic bar search uses exact category aliases, never unbounded names or category substrings', async () => {
  await withFindMany(async (request) => {
    const args = request as { where: { discoverable: boolean; AND: [unknown, { OR: unknown[] }] } };
    assert.equal(args.where.discoverable, true);
    const filters = args.where.AND[1].OR;
    const categories = filters.map((filter) => {
      const value = filter as { category: { equals: string; mode: string } };
      assert.deepEqual(filter, { category: { equals: value.category.equals, mode: 'insensitive' } });
      return value.category.equals;
    });
    for (const alias of ['bar', 'pub', 'cocktail', 'cocktail_bar', 'wine_bar', 'sports_bar']) assert.ok(categories.includes(alias));
    assert.ok(!categories.includes('barber'));
    assert.ok(!categories.includes('barber_shop'));
    return [];
  }, async () => {
    await conciergeVenues({ ...search, query: 'bar', rail: 'nightlife' });
    await conciergeVenues({ ...search, query: 'Pub', rail: 'nightlife' });
  });
});

test('coffee aliases use exact categories while dish and explicit name searches retain specific text', async () => {
  let filters: unknown[] = [];
  await withFindMany(async (request) => {
    const args = request as { where: { AND: [unknown, { OR: unknown[] }] } };
    filters = args.where.AND[1].OR;
    return [];
  }, async () => {
    await conciergeVenues({ ...search, query: 'coffee' });
    for (const category of ['coffee', 'cafe', 'café', 'coffee_shop']) {
      assert.ok(filters.some((filter) => JSON.stringify(filter) === JSON.stringify({ category: { equals: category, mode: 'insensitive' } })));
    }
    assert.ok(filters.every((filter) => !Object.hasOwn(filter as object, 'name')));
    await conciergeVenues(search);
    assert.deepEqual(filters, [{ name: { contains: 'dumplings', mode: 'insensitive' } }, { category: { contains: 'dumplings', mode: 'insensitive' } }]);
    await conciergeVenues({ ...search, mode: 'name', query: "Joe's Coffee" });
    assert.deepEqual(filters, [{ name: { contains: "Joe's Coffee", mode: 'insensitive' } }]);
  });
});
