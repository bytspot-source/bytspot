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

import {
  createWindowInput,
  customTemplate,
  publishBlockers,
  resolveTemplate,
  skuTemplate,
  windowBlockers,
  windowTemplate,
} from './windows';
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

test('a blank resolves only to a domain and variant the catalog already lists', () => {
  const blank = customTemplate('custom.wellness.facial');
  assert.equal(blank?.domain, 'wellness');
  assert.equal(blank?.title, 'Facial');
  // Borrowed from the domain's printed preset, so it lands on the same rail.
  assert.equal(blank?.discoverType, skuTemplate('wellness.massage-60')?.discoverType ?? blank?.discoverType);
  assert.ok(resolveTemplate('custom.coffee.tasting'));

  for (const id of ['custom.wellness.tattoo', 'custom.pets.walk', 'custom.wellness', 'custom.wellness.facial.extra', 'wellness.facial']) {
    assert.equal(resolveTemplate(id), undefined, id);
  }
});

test('a blank has to be named and priced before it is saved', () => {
  const blank = { ...draft, skuTemplateId: 'custom.wellness.facial' };
  const template = resolveTemplate(blank.skuTemplateId);
  assert.deepEqual(windowBlockers(blank, template, { state: 'ACTIVE' }), ['Give it a name guests will see', 'Set a price']);
  assert.deepEqual(windowBlockers({ ...blank, title: '  ', priceCents: 0 }, template, { state: 'ACTIVE' }), [
    'Give it a name guests will see',
  ]);
  assert.deepEqual(windowBlockers({ ...blank, title: 'Hydrafacial', priceCents: 9500 }, template, { state: 'ACTIVE' }), []);
  // A preset needs neither: it has the catalog's.
  assert.deepEqual(windowBlockers(draft, skuTemplate(draft.skuTemplateId), { state: 'ACTIVE' }), []);

  assert.equal(createWindowInput.safeParse({ ...blank, durationMins: 2 }).success, false);
  assert.equal(createWindowInput.safeParse({ ...blank, title: 'x'.repeat(81) }).success, false);
  assert.equal(
    publishBlockers({ sellerState: 'ACTIVE', locationState: 'ACTIVE', timezone: 'America/New_York', skuTemplateId: blank.skuTemplateId }).length,
    0,
  );
});

test('the seller\'s name and length win over the template\'s', () => {
  const preset = skuTemplate(draft.skuTemplateId)!;
  assert.equal(windowTemplate({ skuTemplateId: preset.id })?.title, preset.title);
  const named = windowTemplate({ skuTemplateId: preset.id, title: 'Airport run', durationMins: 90 });
  assert.equal(named?.title, 'Airport run');
  assert.equal(named?.durationMins, 90);
  assert.equal(windowTemplate({ skuTemplateId: preset.id, title: '   ' })?.title, preset.title);
});

test('a business drafts only inside the categories it chose', () => {
  const valetOnly = ['parking', 'ride'];
  const transfer = skuTemplate(draft.skuTemplateId);
  assert.deepEqual(windowBlockers(draft, transfer, { state: 'ACTIVE' }, valetOnly), []);
  assert.deepEqual(windowBlockers(draft, transfer, { state: 'ACTIVE' }, ['table']), [
    'That is outside what your business sells. Add the category first',
  ]);
  // A blank is held to the same line.
  const facial = { ...draft, skuTemplateId: 'custom.wellness.facial', title: 'Hydrafacial', priceCents: 9500 };
  assert.equal(windowBlockers(facial, resolveTemplate(facial.skuTemplateId), { state: 'ACTIVE' }, valetOnly).length, 1);
  assert.deepEqual(windowBlockers(facial, resolveTemplate(facial.skuTemplateId), { state: 'ACTIVE' }, ['service']), []);
  // No kind yet: everything stays open.
  assert.deepEqual(windowBlockers(facial, resolveTemplate(facial.skuTemplateId), { state: 'ACTIVE' }, undefined), []);
});
