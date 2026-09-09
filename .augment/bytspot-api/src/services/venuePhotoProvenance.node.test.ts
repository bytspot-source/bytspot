import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FALLBACK_PROVENANCE,
  VENUE_PHOTO_PROVENANCE,
  earnsMapPin,
  isVenuePhotoProvenance,
  mapPresentation,
  pinPhotoUrl,
  projectVenuePhoto,
  readProvenance,
} from './venuePhotoProvenance';

const OWNED_PHOTO = 'https://res.cloudinary.com/bytspot/ace.jpg';
const BORROWED_PHOTO = 'https://maps.googleapis.com/place/photo?ref=abc';

test('The gate fails closed on anything it cannot read', () => {
  assert.equal(FALLBACK_PROVENANCE, 'borrowed');
  for (const unreadable of [undefined, null, '', 'google_places', 'BYTSPOT_OWNED', 0, {}, []]) {
    assert.equal(readProvenance(unreadable), 'borrowed');
    assert.equal(isVenuePhotoProvenance(unreadable), false);
  }
  // An unrecognised value must not earn a pin even with a photograph present.
  assert.equal(earnsMapPin({ photoProvenance: 'google_places', imageUrl: OWNED_PHOTO }), false);
});

test('Only owned and host-uploaded provenance earns a pin', () => {
  assert.deepEqual([...VENUE_PHOTO_PROVENANCE], ['bytspot_owned', 'party_media', 'borrowed']);
  assert.equal(earnsMapPin({ photoProvenance: 'bytspot_owned', imageUrl: OWNED_PHOTO }), true);
  assert.equal(earnsMapPin({ photoProvenance: 'party_media', imageUrl: OWNED_PHOTO }), true);
  assert.equal(earnsMapPin({ photoProvenance: 'borrowed', imageUrl: BORROWED_PHOTO }), false);
});

test('The endorsement is the photograph, not the claim about it', () => {
  for (const missing of [null, undefined, '', '   ']) {
    assert.equal(earnsMapPin({ photoProvenance: 'bytspot_owned', imageUrl: missing }), false,
      'owned provenance with no image is still a dot');
    assert.equal(mapPresentation({ photoProvenance: 'party_media', imageUrl: missing }), 'dot');
  }
});

test('A dot never carries a photograph the map could render', () => {
  assert.equal(pinPhotoUrl({ photoProvenance: 'bytspot_owned', imageUrl: OWNED_PHOTO }), OWNED_PHOTO);
  // Borrowed imagery exists for the detail view, but must not reach the map.
  assert.equal(pinPhotoUrl({ photoProvenance: 'borrowed', imageUrl: BORROWED_PHOTO }), null);
  assert.equal(pinPhotoUrl({ photoProvenance: 'google_places', imageUrl: BORROWED_PHOTO }), null);
});

test('Today\u2019s production shape \u2014 borrowed supply \u2014 projects to dots that still attribute', () => {
  const borrowed = projectVenuePhoto({
    photoProvenance: 'borrowed',
    photoAttribution: 'Google',
    imageUrl: BORROWED_PHOTO,
  });
  assert.deepEqual(borrowed, {
    photoProvenance: 'borrowed',
    photoAttribution: 'Google',
    mapPresentation: 'dot',
    pinPhotoUrl: null,
  });

  const owned = projectVenuePhoto({ photoProvenance: 'bytspot_owned', imageUrl: OWNED_PHOTO });
  assert.deepEqual(owned, {
    photoProvenance: 'bytspot_owned',
    photoAttribution: null,
    mapPresentation: 'pin',
    pinPhotoUrl: OWNED_PHOTO,
  });
});

test('A venue row missing the column entirely still projects to a dot', () => {
  const legacy = projectVenuePhoto({ photoProvenance: undefined, imageUrl: BORROWED_PHOTO });
  assert.equal(legacy.photoProvenance, 'borrowed');
  assert.equal(legacy.mapPresentation, 'dot');
  assert.equal(legacy.pinPhotoUrl, null);
});
