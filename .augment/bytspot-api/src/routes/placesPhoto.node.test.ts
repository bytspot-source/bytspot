import test from 'node:test';
import assert from 'node:assert/strict';
import { clampWidth, isAllowedRedirect, isPhotoName, photoProxyUrl } from './placesPhoto';
import { nearbySearchCacheKey, placesRouter } from '../trpc/placesRouter';
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

test('Requested width collapses into buckets so keys cannot be minted freely', () => {
  // Every distinct width is a distinct cache key and therefore a billed
  // Google request on miss. Off-by-one widths must share a bucket.
  assert.equal(clampWidth(400), 400);
  assert.equal(clampWidth(401), 800);
  assert.equal(clampWidth(399), 400);
  assert.equal(clampWidth(10), 200);
  assert.equal(clampWidth(99999), 1600);
  assert.equal(clampWidth('abc'), 800);
  assert.equal(clampWidth(undefined), 800);
  // A sweep of pixel widths must not produce a distinct key per pixel.
  const distinct = new Set(Array.from({ length: 400 }, (_, i) => clampWidth(200 + i)));
  assert.ok(distinct.size <= 4, `width sweep produced ${distinct.size} keys`);
});

test('Only a keyless Google image host is redirected to', () => {
  assert.equal(isAllowedRedirect('https://lh3.googleusercontent.com/place-photo/AeJ'), true);
  assert.equal(isAllowedRedirect('https://googleusercontent.com/x'), true);
  // If the upstream ever returned something else, an unvalidated 302 would
  // turn this endpoint into an open redirect.
  assert.equal(isAllowedRedirect('https://evil.example/x'), false);
  assert.equal(isAllowedRedirect('https://googleusercontent.com.evil.example/x'), false);
  assert.equal(isAllowedRedirect('http://lh3.googleusercontent.com/x'), false);
  assert.equal(isAllowedRedirect('javascript:alert(1)'), false);
  assert.equal(isAllowedRedirect('//evil.example'), false);
  assert.equal(isAllowedRedirect(''), false);
});

test('The proxy URL points at this server and encodes the name', () => {
  const url = photoProxyUrl('places/ChIJtest/photos/AeJbb3c', 400);
  assert.ok(url.startsWith(`${config.publicApiUrl}/places/photo?`));
  // Unencoded slashes would break out of the query parameter.
  assert.ok(url.includes('name=places%2FChIJtest%2Fphotos%2FAeJbb3c'));
  assert.ok(url.endsWith('&w=400'));
});

/**
 * The mapper fix alone was not enough: Redis held serialized places whose
 * photoUrls still carried the key, readable for their TTL and for a week in
 * the stale copies. The namespace bump is what makes those unreachable.
 */
test('Entries cached while photo URLs carried the key cannot be served', () => {
  const key = nearbySearchCacheKey(33.7844, -84.3862, 2000, ['cafe', 'coffee_shop'], 10);
  // The vulnerable build wrote gp:nearby:*; nothing may read that prefix now.
  assert.equal(key.startsWith('gp:nearby:'), false, 'still reading the leaking namespace');
  assert.ok(key.startsWith('gp:v2:nearby:'));
  // The stale copy derives from the same key, so it moves with it. A 7-day
  // stale entry from the old build was the longest-lived exposure.
  assert.equal(`${key}:stale`.includes(':v2:'), true);
});
