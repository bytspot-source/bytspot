import assert from 'node:assert/strict';
import test from 'node:test';
import { WINDOW_INTENTS, setIntentInput } from './windowIntent';

/**
 * The vocabulary a seller may speak.
 *
 * The route refuses the unbuilt words, and the CHECK constraint refuses them
 * again. Two gates on purpose: a careless route must not be able to store a
 * promise the platform cannot keep.
 */

test('a seller may only say what the platform can honour', () => {
  assert.deepEqual([...WINDOW_INTENTS], ['request', 'none']);

  // Built, so sayable.
  assert.equal(setIntentInput.safeParse({ intent: 'request' }).success, true);
  // Declining is sayable, because a gate that can only say yes gates nothing.
  assert.equal(setIntentInput.safeParse({ intent: 'none' }).success, true);
});

test('words whose rail does not exist are refused at the door', () => {
  // Each of these is a real intent a vendor will eventually want. None of them
  // has anything behind it yet, so none may be stored.
  for (const intent of ['book', 'order', 'redirect', 'details']) {
    assert.equal(setIntentInput.safeParse({ intent }).success, false, `${intent} must not be accepted yet`);
  }

  // Nor any near-miss of the one word that works.
  for (const intent of ['REQUEST', 'Request', ' request', '', null, undefined, 1, {}]) {
    assert.equal(setIntentInput.safeParse({ intent }).success, false);
  }
});

/* ── Authoring and publishing a window ─────────────────────────────────── */

import { createWindowInput, publishBlockers, skuTemplate, windowBlockers } from './windows';
import { boundingBox, pickImagery } from './inventory';

const draft = {
  skuTemplateId: 'automotive.private-transfer',
  locationId: 'loc_1',
  weekdays: [1, 2, 3, 4, 5],
  openMins: 9 * 60,
  closeMins: 17 * 60,
  quantity: 2,
};

test('a window is a catalog template sold from one of your places', () => {
  assert.ok(skuTemplate(draft.skuTemplateId));
  assert.deepEqual(windowBlockers(draft, skuTemplate(draft.skuTemplateId), { state: 'DRAFT' }), []);
  assert.deepEqual(windowBlockers({ ...draft, skuTemplateId: 'made.up' }, undefined, { state: 'ACTIVE' }), [
    'That is not something Bytspot sells yet',
  ]);
  assert.deepEqual(windowBlockers(draft, skuTemplate(draft.skuTemplateId), undefined), ['Choose one of your places']);
  assert.deepEqual(windowBlockers(draft, skuTemplate(draft.skuTemplateId), { state: 'CLOSED' }), ['That place is closed']);
});

test('a window has to be open long enough to hold a slot', () => {
  const template = skuTemplate(draft.skuTemplateId);
  assert.deepEqual(windowBlockers({ ...draft, closeMins: draft.openMins }, template, { state: 'ACTIVE' }), [
    'Closing has to come after opening',
  ]);
  // Automotive rolls in 60-minute slots, so 30 minutes holds none.
  assert.deepEqual(windowBlockers({ ...draft, closeMins: draft.openMins + 30 }, template, { state: 'ACTIVE' }), [
    'Open for at least 60 minutes',
  ]);
});

test('the shape of a window is bounded before it reaches the database', () => {
  assert.equal(createWindowInput.safeParse(draft).success, true);
  assert.equal(createWindowInput.safeParse({ ...draft, weekdays: [] }).success, false);
  assert.equal(createWindowInput.safeParse({ ...draft, weekdays: [7] }).success, false);
  assert.equal(createWindowInput.safeParse({ ...draft, quantity: 0 }).success, false);
  assert.equal(createWindowInput.safeParse({ ...draft, openMins: -1 }).success, false);
});

test('publishing needs an approved business, an active place and a time zone', () => {
  const ready = {
    sellerState: 'ACTIVE' as const,
    locationState: 'ACTIVE' as const,
    timezone: 'America/New_York',
    skuTemplateId: draft.skuTemplateId,
  };
  assert.deepEqual(publishBlockers(ready), []);
  assert.deepEqual(publishBlockers({ ...ready, sellerState: 'PENDING' }), ['Your business has to be approved first']);
  assert.deepEqual(publishBlockers({ ...ready, locationState: 'PAUSED' }), ['Activate this place first']);
  assert.deepEqual(publishBlockers({ ...ready, timezone: null }), ['This place needs a time zone']);
});

test('a card shows the seller\'s own pictures, window first, and never a stock one', () => {
  const window = [
    { id: 'w_gal', kind: 'gallery', position: 0 },
    { id: 'w_cov', kind: 'cover', position: 0 },
  ];
  const place = [
    { id: 'p_cov', kind: 'cover', position: 0 },
    { id: 'p_gal1', kind: 'gallery', position: 1 },
    { id: 'p_gal0', kind: 'gallery', position: 0 },
  ];
  const both = pickImagery(window, place);
  assert.match(both.coverUrl ?? '', /\/media\/vendor\/w_cov$/);
  assert.deepEqual(both.galleryUrls.map((url) => url.split('/').pop()), ['w_gal', 'p_gal0', 'p_gal1']);

  assert.match(pickImagery([], place).coverUrl ?? '', /\/media\/vendor\/p_cov$/);
  assert.deepEqual(pickImagery([], []), { coverUrl: null, galleryUrls: [] });
});

test('the search box contains the radius it stands in for', () => {
  const box = boundingBox(33.75, -84.39, 15);
  assert.ok(box.maxLat - 33.75 >= 15 / 69 - 1e-9);
  // Longitude degrees shrink away from the equator, so the box widens.
  assert.ok(box.maxLng - -84.39 > box.maxLat - 33.75);
});
