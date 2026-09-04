import test from 'node:test';
import assert from 'node:assert/strict';
import { clampWidth, isPhotoName, photoProxyUrl } from './placesPhoto';
import { placesRouter } from '../trpc/placesRouter';
import { config } from '../config';

/**
 * The key was previously interpolated into every photo URL returned by
 * places.nearbySearch, which is unauthenticated. Anyone who read a response
 * could bill the account.
 */
test('No photo URL a client receives carries the API key', async () => {
  const originalKey = config.googlePlacesApiKey;
  const originalFetch = globalThis.fetch;
  const secret = 'AIza-test-key-must-never-be-returned';
  (config as { googlePlacesApiKey: string }).googlePlacesApiKey = secret;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    places: [{
      id: 'ChIJtest', displayName: { text: 'For Five Coffee' },
      formattedAddress: '1105 W Peachtree St NW', location: { latitude: 33.78, longitude: -84.38 },
      primaryType: 'cafe', types: ['cafe'],
      photos: [{ name: 'places/ChIJtest/photos/AeJbb3cPHOTOREF' }],
    }],
  }), { status: 200 })) as typeof fetch;
  try {
    const caller = placesRouter.createCaller({ user: null, clientRateLimitKey: 'test-places' } as never);
    const nearby = await caller.nearbySearch({ lat: 33.78, lng: -84.38, radius: 1500, maxResults: 5, types: ['coffee_shop', 'cafe'] });
    const serialized = JSON.stringify(nearby);
    assert.equal(serialized.includes(secret), false, 'nearbySearch leaked the Places key');
    // The photo is still reachable: proxied through this server, not dropped.
    assert.equal(nearby.places.length, 1);
    assert.deepEqual((nearby.places[0] as { photoUrls: string[] }).photoUrls, [
      `${config.publicApiUrl}/places/photo?name=places%2FChIJtest%2Fphotos%2FAeJbb3cPHOTOREF&w=800`,
    ]);

    const single = await caller.photoUrl({ photoName: 'places/ChIJtest/photos/AeJbb3cPHOTOREF', maxWidth: 400 });
    assert.equal(JSON.stringify(single).includes(secret), false, 'photoUrl leaked the Places key');
    assert.match(String(single.url), /\/places\/photo\?name=/);
  } finally {
    (config as { googlePlacesApiKey: string }).googlePlacesApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

/** The name is interpolated into an authenticated outbound URL. */
test('Only a real Google photo resource name is accepted', () => {
  assert.equal(isPhotoName('places/ChIJ_abc-123/photos/AeJbb3c_x-Y'), true);
  // Traversal and absolute-URL injection would redirect our credential.
  assert.equal(isPhotoName('places/../../v1/places:searchNearby/photos/x'), false);
  assert.equal(isPhotoName('https://evil.example/places/x/photos/y'), false);
  assert.equal(isPhotoName('places/x/photos/y?key=stolen'), false);
  assert.equal(isPhotoName('places/x/photos/y&key=stolen'), false);
  assert.equal(isPhotoName('places/x/photos/'), false);
  assert.equal(isPhotoName('photos/y'), false);
  assert.equal(isPhotoName(undefined), false);
  assert.equal(isPhotoName(42), false);
});

test('A malformed photo name is refused rather than proxied', () => {
  // A rejected name must not become a request at all, so nothing is billed
  // and nothing is fetched on an attacker-chosen path.
  const rejected = ['places/x/photos/y?key=stolen', '../secrets', ''];
  for (const name of rejected) assert.equal(isPhotoName(name), false, name);
});

test('Requested width is clamped to a sane range', () => {
  assert.equal(clampWidth(400), 400);
  assert.equal(clampWidth(10), 100);
  assert.equal(clampWidth(99999), 1600);
  assert.equal(clampWidth('abc'), 800);
  assert.equal(clampWidth(undefined), 800);
  assert.equal(clampWidth(400.7), 400);
});

test('The proxy URL points at this server and encodes the name', () => {
  const url = photoProxyUrl('places/ChIJtest/photos/AeJbb3c', 400);
  assert.ok(url.startsWith(`${config.publicApiUrl}/places/photo?`));
  // Unencoded slashes would break out of the query parameter.
  assert.ok(url.includes('name=places%2FChIJtest%2Fphotos%2FAeJbb3c'));
  assert.ok(url.endsWith('&w=400'));
});
