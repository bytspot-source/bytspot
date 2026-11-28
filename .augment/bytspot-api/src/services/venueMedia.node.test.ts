import assert from 'node:assert/strict';
import test from 'node:test';
import { curatedVenueMedia, linkedVendorMedia } from './venueMedia';

const controlled = { controlledAt: new Date('2026-11-01') };
const live = (media: { id: string; kind: string; position: number }[], over: Record<string, unknown> = {}) =>
  ({ state: 'ACTIVE', seller: { state: 'ACTIVE', videoHostingAt: null }, media, ...over }) as never;

test("a partner's own approved photos show when the Bytspot team uploaded none", () => {
  const curated = curatedVenueMedia(controlled, [], linkedVendorMedia(live([
    { id: 'g2', kind: 'gallery', position: 1 }, { id: 'c1', kind: 'cover', position: 0 }, { id: 'g1', kind: 'gallery', position: 0 },
  ])));
  assert.ok(curated);
  assert.match(curated!.imageUrl, /\/media\/vendor\/c1$/);
  assert.deepEqual(curated!.photoUrls.map((url) => url.split('/').pop()), ['c1', 'g1', 'g2']);
  assert.equal(curated!.photoProvenance, 'bytspot_owned');
});

test("the team's uploads come first, then the partner's", () => {
  const curated = curatedVenueMedia(controlled, [{ id: 't1', kind: 'cover', position: 0 }],
    linkedVendorMedia(live([{ id: 'c1', kind: 'cover', position: 0 }])));
  assert.match(curated!.photoUrls[0], /\/media\/venue\/t1$/);
  assert.match(curated!.photoUrls[1], /\/media\/vendor\/c1$/);
});

test("the partner's video shows only with video hosting on; the team's video wins", () => {
  const video = [{ id: 'c1', kind: 'cover', position: 0 }, { id: 'v1', kind: 'video', position: 0 }];
  assert.equal(curatedVenueMedia(controlled, [], linkedVendorMedia(live(video)))!.vibeVideoUrl, null);
  const hosted = linkedVendorMedia(live(video, { seller: { state: 'ACTIVE', videoHostingAt: new Date() } }));
  assert.match(curatedVenueMedia(controlled, [], hosted)!.vibeVideoUrl ?? '', /\/media\/vendor\/v1$/);
  assert.match(curatedVenueMedia(controlled, [{ id: 'tv', kind: 'video', position: 0 }, { id: 't1', kind: 'cover', position: 0 }], hosted)!.vibeVideoUrl ?? '', /\/media\/venue\/tv$/);
});

test('nothing from a paused place or a business that is not live, and nothing for a listed venue', () => {
  const media = [{ id: 'c1', kind: 'cover', position: 0 }];
  assert.equal(linkedVendorMedia(live(media, { state: 'PAUSED' })), null);
  assert.equal(linkedVendorMedia(live(media, { seller: { state: 'SUSPENDED', videoHostingAt: null } })), null);
  assert.equal(curatedVenueMedia({ controlledAt: null }, [], linkedVendorMedia(live(media))), null);
  assert.equal(curatedVenueMedia(controlled, [], null), null);
});
