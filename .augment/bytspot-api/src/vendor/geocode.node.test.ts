import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../config';
import {
  candidateBlockers,
  geocode,
  geocodeFetch,
  knownTimezone,
  mapCandidates,
  precisionSufficientFor,
  requiredPrecisionFor,
  timezoneAt,
  type GeocodeCandidate,
} from './geocode';

const result = (types: string[] = [], lat = 33.78, lng = -84.38, timeZone: string | null = 'America/New_York') => ({
  formattedAddress: '1 Peachtree St NE, Atlanta, GA 30303',
  types,
  location: { latitude: lat, longitude: lng },
  timeZone: timeZone === null ? undefined : { id: timeZone },
});

test('a building or business is rooftop, a street address only street', () => {
  assert.equal(mapCandidates([result(['premise'])])[0].precision, 'rooftop');
  assert.equal(mapCandidates([result(['restaurant', 'establishment'])])[0].precision, 'rooftop');
  // May be estimated between two known house numbers. Street-accurate, not rooftop.
  assert.equal(mapCandidates([result(['street_address'])])[0].precision, 'street');
  assert.equal(mapCandidates([result(['route'])])[0].precision, 'street');
});

test('an area is a locality at best', () => {
  assert.equal(mapCandidates([result(['locality', 'political'])])[0].precision, 'locality');
  assert.equal(mapCandidates([result(['postal_code'])])[0].precision, 'locality');
  assert.equal(mapCandidates([result(['country'])])[0].precision, 'region');
  // No types is read down, never up.
  assert.equal(mapCandidates([result([])])[0].precision, 'region');
});

test('a candidate carries the time zone the place keeps, and only a real one', () => {
  assert.equal(mapCandidates([result(['premise'])])[0].timezone, 'America/New_York');
  assert.equal(mapCandidates([result(['premise'], 33.78, -84.38, 'Mars/Olympus_Mons')])[0].timezone, undefined);
  assert.equal(mapCandidates([result(['premise'], 33.78, -84.38, null)])[0].timezone, undefined);
});

test('knownTimezone keeps IANA names and drops the rest', () => {
  assert.equal(knownTimezone('America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(knownTimezone('Not/AZone'), undefined);
  assert.equal(knownTimezone(''), undefined);
  assert.equal(knownTimezone(null), undefined);
});

async function withPlaces<T>(reply: (url: string, init?: RequestInit) => Response, run: () => Promise<T>) {
  const original = geocodeFetch.call;
  const key = config.googlePlacesApiKey;
  const calls: { url: string; init?: RequestInit }[] = [];
  (config as { googlePlacesApiKey: string }).googlePlacesApiKey = 'test-key';
  geocodeFetch.call = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return reply(url, init);
  }) as typeof geocodeFetch.call;
  try {
    return { value: await run(), calls };
  } finally {
    geocodeFetch.call = original;
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = key;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('geocode asks Places text search, with the key in a header rather than the URL', async () => {
  const { value, calls } = await withPlaces(
    () => json({ places: [result(['street_address'])] }),
    () => geocode('1 Peachtree St NE'),
  );
  assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places:searchText');
  assert.doesNotMatch(calls[0].url, /key=/);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['X-Goog-Api-Key'], 'test-key');
  assert.match(headers['X-Goog-FieldMask'], /places\.timeZone/);
  assert.ok(value.ok && value.candidates[0].timezone === 'America/New_York');
});

test('a refused key is an outage, not "your address does not exist"', async () => {
  const refused = await withPlaces(() => json({ error: { status: 'PERMISSION_DENIED' } }, 403), () => geocode('1 Peachtree'));
  assert.deepEqual(refused.value, { ok: false, reason: 'upstream' });
  // No places at all is a real answer.
  const empty = await withPlaces(() => json({}), () => geocode('nowhere at all'));
  assert.deepEqual(empty.value, { ok: true, candidates: [] });
});

test('timezoneAt reads the nearest place, and gives up rather than guessing', async () => {
  const found = await withPlaces(() => json({ places: [{ timeZone: { id: 'America/Chicago' } }] }), () => timezoneAt(40, -100));
  assert.equal(found.value, 'America/Chicago');
  assert.equal(found.calls[0].url, 'https://places.googleapis.com/v1/places:searchNearby');

  assert.equal((await withPlaces(() => json({}, 500), () => timezoneAt(40, -100))).value, undefined);
  assert.equal((await withPlaces(() => json({ places: [] }), () => timezoneAt(40, -100))).value, undefined);
  const island = await withPlaces(() => json({ places: [{ timeZone: { id: 'Etc/UTC' } }] }), () => timezoneAt(0, 0));
  assert.equal(island.value, undefined);
  assert.equal(island.calls.length, 0);
});

test('Null Island is dropped, not returned as a pin', () => {
  // Every provider emits it eventually, and it is always a failed lookup that
  // forgot to say so.
  assert.deepEqual(mapCandidates([result(['premise'], 0, 0)]), []);
});

test('an impossible coordinate is dropped', () => {
  assert.deepEqual(mapCandidates([result(['premise'], 91, 0)]), []);
  assert.deepEqual(mapCandidates([result(['premise'], 0, 181)]), []);
  assert.deepEqual(mapCandidates([{ formattedAddress: 'x' }]), []);
});

test('candidates come back most precise first', () => {
  const ordered = mapCandidates([
    result(['locality']),
    result(['premise']),
    result(['street_address']),
  ]);
  assert.deepEqual(
    ordered.map((candidate) => candidate.precision),
    ['rooftop', 'street', 'locality'],
  );
});

test('a place guests travel to needs a street, one the vendor travels from does not', () => {
  assert.equal(requiredPrecisionFor('fixed'), 'street');
  assert.equal(requiredPrecisionFor('zone'), 'street');
  // The pin is the centre of a radius, so a centroid is a legitimate answer —
  // a visiting provider should not have to publish their street.
  assert.equal(requiredPrecisionFor('mobile'), 'locality');
  assert.equal(requiredPrecisionFor('visiting'), 'locality');
});

test('a town centroid is refused for a place guests navigate to', () => {
  const centroid: GeocodeCandidate = {
    formatted: 'Atlanta, GA',
    lat: 33.749,
    lng: -84.388,
    precision: 'locality',
  };
  assert.ok(!precisionSufficientFor('fixed', 'locality'));
  const blockers = candidateBlockers('fixed', centroid);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /street address, not just a town/);

  // The same candidate is fine for a vendor who travels.
  assert.deepEqual(candidateBlockers('visiting', centroid), []);
});

test('a region is too broad even for a travel radius', () => {
  const region: GeocodeCandidate = { formatted: 'Georgia', lat: 32.6, lng: -83.4, precision: 'region' };
  assert.match(candidateBlockers('visiting', region)[0], /too broad/);
});

test('an unknown kind is refused rather than defaulted', () => {
  const candidate: GeocodeCandidate = { formatted: 'x', lat: 1, lng: 1, precision: 'rooftop' };
  assert.deepEqual(candidateBlockers('warehouse' as never, candidate), ['warehouse is not a location kind']);
});

test('a rooftop pin at Null Island is still refused', () => {
  // Precision high, coordinate meaningless: both are checked, because a
  // provider will happily claim the first about the second.
  const broken: GeocodeCandidate = { formatted: '', lat: 0, lng: 0, precision: 'rooftop' };
  assert.deepEqual(candidateBlockers('fixed', broken), ['That result came back empty']);
});
