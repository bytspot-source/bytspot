import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAtlantaEvents, mapTmEvent } from './eventsRouter';

const base = { id: 'tm-1', name: 'Show', url: 'https://example.com/e' };

test('Ticketmaster venue location and address reach the event', () => {
  const event = mapTmEvent({
    ...base,
    _embedded: { venues: [{
      name: 'Alliance Theatre', address: { line1: '1280 Peachtree St NE' }, city: { name: 'Atlanta' },
      state: { stateCode: 'GA' }, postalCode: '30309', location: { latitude: '33.789600', longitude: '-84.385400' },
    }] },
  });
  assert.equal(event.venue, 'Alliance Theatre');
  assert.equal(event.address, '1280 Peachtree St NE, Atlanta, GA 30309');
  assert.equal(event.lat, 33.7896);
  assert.equal(event.lng, -84.3854);
});

test('missing, blank, unparsable or zero coordinates are never sent', () => {
  for (const location of [undefined, {}, { latitude: '', longitude: '' }, { latitude: 'abc', longitude: '-84.3' },
    { latitude: '0', longitude: '0' }, { latitude: '95', longitude: '-84.3' }, { latitude: '33.7' }]) {
    const event = mapTmEvent({ ...base, _embedded: { venues: [{ name: 'Venue', location }] } });
    assert.equal(event.lat, null, JSON.stringify(location));
    assert.equal(event.lng, null, JSON.stringify(location));
  }
});

test('an event without a venue keeps its fallback label and no address', () => {
  const event = mapTmEvent(base);
  assert.equal(event.venue, 'Atlanta Venue');
  assert.equal(event.address, null);
  assert.equal(event.lat, null);
});

const passThrough = <T,>(_key: string, _ttl: number, load: () => Promise<T>) => load();
const reply = (status: number, body: unknown) => (async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('no Ticketmaster key: unavailable, no sample events', async () => {
  let called = false;
  const result = await loadAtlantaEvents({ limit: 20 }, {
    apiKey: undefined, cache: passThrough, fetch: (async () => { called = true; throw new Error('unreachable'); }) as unknown as typeof fetch,
  });
  assert.deepEqual(result, { events: [], source: 'unavailable' });
  assert.equal(called, false);
});

test('a Ticketmaster error is unavailable and is not cached', async () => {
  const stored: string[] = [];
  const cache = async <T,>(key: string, _ttl: number, load: () => Promise<T>) => { const value = await load(); stored.push(key); return value; };
  const errorSpy = console.error; console.error = () => {};
  try {
    const result = await loadAtlantaEvents({ limit: 20 }, { apiKey: 'test-key', cache, fetch: reply(503, {}) });
    assert.deepEqual(result, { events: [], source: 'unavailable' });
    const thrown = await loadAtlantaEvents({ limit: 20 }, {
      apiKey: 'test-key', cache, fetch: (async () => { throw new Error('timeout'); }) as unknown as typeof fetch,
    });
    assert.deepEqual(thrown, { events: [], source: 'unavailable' });
  } finally { console.error = errorSpy; }
  assert.deepEqual(stored, []);
});

test('Ticketmaster events come back mapped and marked ticketmaster', async () => {
  const result = await loadAtlantaEvents({ limit: 20 }, {
    apiKey: 'test-key', cache: passThrough, fetch: reply(200, { _embedded: { events: [base] } }),
  });
  assert.equal(result.source, 'ticketmaster');
  assert.deepEqual(result.events.map((e) => e.id), ['tm-1']);
});

test('an empty Ticketmaster reply is real and empty, not unavailable', async () => {
  const result = await loadAtlantaEvents({ limit: 20 }, { apiKey: 'test-key', cache: passThrough, fetch: reply(200, {}) });
  assert.deepEqual(result, { events: [], source: 'ticketmaster' });
});
