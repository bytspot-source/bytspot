import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { TRPC_HTTP_OPTIONS } from './httpOptions';
import { placesRouter } from './placesRouter';
import { publicProcedure, router, resetLocalRateLimitForTests } from './trpc';

const app = router({ places: placesRouter, probe: router({ write: publicProcedure.mutation(() => 'written') }) });
const serve = (request: Request, options: { allowMethodOverride?: boolean } = TRPC_HTTP_OPTIONS) => fetchRequestHandler({
  endpoint: '/trpc', req: request, router: app, ...options,
  createContext: () => ({ user: null, clientRateLimitKey: 'http-options-test' }),
});

/** A deck the size Discover really sends near Midtown: 48 listed places and 31 Google places. */
const deck = () => ({
  lat: 33.781, lng: -84.3833, hour: 19,
  candidates: [
    ...Array.from({ length: 48 }, (_, i) => ({ id: `reference:venue-cmwh56sug001qpb24rsfc${String(i).padStart(4, '0')}`, kind: 'venue' as const, rail: 'dining', category: 'restaurant', lat: 33.78 + i / 1000, lng: -84.38, crowdLevel: 1 })),
    ...Array.from({ length: 31 }, (_, i) => ({ id: `reference:place-ChIJk9TolFEI9YgRG28dZaKe${String(i).padStart(4, '0')}`, kind: 'place' as const, rail: 'dining', primaryType: 'italian_restaurant', priceLevel: 'PRICE_LEVEL_MODERATE', types: ['italian_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'], rating: 4.5, ratingCount: 812, isOpen: true, lat: 33.79 + i / 1000, lng: -84.38 })),
  ],
});

test('Discover ranking is answered as a POST, so a full deck no longer has to fit in the URL', async () => {
  resetLocalRateLimitForTests();
  const input = deck();
  const asQuery = `http://api.test/trpc/places.rankDiscover?input=${encodeURIComponent(JSON.stringify(input))}`;
  assert.ok(asQuery.length > 16_000, 'this deck is over the 16 KB the server accepts in a URL');

  const post = (options?: { allowMethodOverride?: boolean }) => serve(new Request('http://api.test/trpc/places.rankDiscover', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }), options);
  const response = await post();
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { data: { order: string[]; hidden: unknown[] } } };
  assert.equal(body.result.data.order.length + body.result.data.hidden.length, input.candidates.length, 'every card is ranked or hidden');

  assert.equal((await post({})).status, 405, 'without the option a POST to a query is refused, which is what the app got before');
  resetLocalRateLimitForTests();
});

test('a GET still cannot run a mutation, and a POST still can', async () => {
  const write = (method: 'GET' | 'POST') => serve(new Request('http://api.test/trpc/probe.write', method === 'POST'
    ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method }));
  assert.equal((await write('GET')).status, 405);
  assert.equal((await write('POST')).status, 200);
});
