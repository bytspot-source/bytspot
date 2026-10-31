import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTmEvent } from './eventsRouter';

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
