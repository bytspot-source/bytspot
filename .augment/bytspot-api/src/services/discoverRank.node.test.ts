import test from 'node:test';
import assert from 'node:assert/strict';
import { rankDiscover, type DiscoverCandidate } from './discoverRank';
import { placesRouter } from '../trpc/placesRouter';

const here = { lat: 33.7816, lng: -84.3831 };
const near = { lat: 33.7826, lng: -84.3831 }; // ~110 m
const far = { lat: 33.8216, lng: -84.3831 }; // ~4.4 km

function place(id: string, extra: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return { id, kind: 'place', rail: 'dining', ...near, ...extra };
}

test('A vibe match outranks an otherwise equal card', () => {
  const result = rankDiscover({ ...here, vibe: 'coffee' }, [
    place('reference:bar', { rail: 'nightlife', types: ['bar'], primaryType: 'bar' }),
    place('reference:cafe', { rail: 'coffee', types: ['cafe', 'coffee_shop'], primaryType: 'coffee_shop' }),
  ]);
  assert.deepEqual(result.order, ['reference:cafe', 'reference:bar']);
});

test('Gatherings lead, then cards with an action, whatever the score', () => {
  const result = rankDiscover({ ...here, vibe: 'coffee' }, [
    place('reference:cafe', { rail: 'coffee', primaryType: 'coffee_shop', rating: 4.9, ratingCount: 900 }),
    { id: 'offering:room', kind: 'offering', rail: 'dining', actionable: true },
    { id: 'invitation:p1', kind: 'party', rail: 'event' },
  ]);
  assert.deepEqual(result.order, ['invitation:p1', 'offering:room', 'reference:cafe']);
});

test('Avoided and over-ceiling cards come back hidden; an unlisted price stays', () => {
  const result = rankDiscover({ ...here, preferences: { avoid: ['nightclubs', 'busy'], priceCeiling: 2 } }, [
    place('reference:club', { rail: 'nightlife', types: ['night_club'] }),
    place('reference:steak', { priceLevel: 'PRICE_LEVEL_VERY_EXPENSIVE' }),
    place('reference:diner', { priceLevel: 'PRICE_LEVEL_INEXPENSIVE' }),
    place('reference:unlisted'),
    { id: 'reference:venue-packed', kind: 'venue', category: 'restaurant', crowdLevel: 4, ...near },
    { id: 'reference:venue-lounge', kind: 'venue', category: 'Cocktail Lounge', ...near },
  ]);
  assert.deepEqual(result.hidden, [
    { id: 'reference:club', hiddenBy: 'nightclubs' },
    { id: 'reference:steak', hiddenBy: 'price' },
    { id: 'reference:venue-packed', hiddenBy: 'busy' },
  ]);
  assert.deepEqual(new Set(result.order), new Set(['reference:diner', 'reference:unlisted', 'reference:venue-lounge']));
  // A known price within the ceiling edges out an unlisted one.
  assert.ok(result.order.indexOf('reference:diner') < result.order.indexOf('reference:unlisted'));
});

test('Distance sinks a card but never drops it', () => {
  const result = rankDiscover({ ...here, walk: 'close' }, [
    place('reference:far', far),
    place('reference:near'),
  ]);
  assert.deepEqual(result.order, ['reference:near', 'reference:far']);
});

test('Open beats closed; five stars from three reviews do not beat a well-reviewed place', () => {
  const result = rankDiscover(here, [
    place('reference:closed', { rating: 4.7, ratingCount: 900, isOpen: false }),
    place('reference:three-reviews', { rating: 5, ratingCount: 3 }),
    place('reference:solid', { rating: 4.7, ratingCount: 900 }),
  ]);
  assert.equal(result.order[0], 'reference:solid');
});

test('Duplicate ids are ranked once; ties fall back to id order', () => {
  const result = rankDiscover(here, [place('reference:b'), place('reference:a'), place('reference:b')]);
  assert.deepEqual(result.order, ['reference:a', 'reference:b']);
});

test('places.rankDiscover takes the client preferences and drops junk tags', async () => {
  const caller = placesRouter.createCaller({ user: null, clientRateLimitKey: 'rank-test' } as never);
  const result = await caller.rankDiscover({
    ...here,
    preferences: { avoid: ['bars'] },
    candidates: [place('reference:pub', { types: ['pub'] }), place('reference:cafe', { types: ['cafe'] })],
  });
  assert.deepEqual(result.order, ['reference:cafe']);
  assert.deepEqual(result.hidden, [{ id: 'reference:pub', hiddenBy: 'bars' }]);
  await assert.rejects(caller.rankDiscover({ ...here, candidates: [{ ...place('x'), kind: 'nope' as never }] }));
});
