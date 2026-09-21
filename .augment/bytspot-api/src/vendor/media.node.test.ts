import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEDIA_CAPS,
  MEDIA_REFUSALS,
  mediaHttpStatus,
  parseVendorMediaDataUri,
  planUpload,
  planVideoUpload,
  seatCanSeeBookable,
  seatCanSeeLocation,
  vendorCanEditMedia,
} from './media';
import { vendorObjectKey } from './mediaStore';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const jpegUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const pdfUri = `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`;

test('an assigned seat sees only named places and windows; an empty assignment sees nothing', () => {
  assert.equal(seatCanSeeLocation('owner', [], 'loc_1'), true);
  assert.equal(seatCanSeeBookable('manager', [], 'win_1'), true);
  assert.equal(seatCanSeeLocation('staff', ['loc_1'], 'loc_2'), true);
  assert.equal(seatCanSeeLocation('serviceProvider', ['loc_1'], 'loc_1'), true);
  assert.equal(seatCanSeeLocation('serviceProvider', ['loc_1'], 'loc_2'), false);
  assert.equal(seatCanSeeBookable('serviceProvider', [], 'win_1'), false);
  assert.equal(seatCanSeeBookable('serviceProvider', ['win_1'], 'win_1'), true);
});

test('an owner can hang media on a draft business, a door cannot, and a suspended one cannot', () => {
  assert.equal(vendorCanEditMedia('owner', 'DRAFT'), true);
  assert.equal(vendorCanEditMedia('manager', 'PENDING'), true);
  assert.equal(vendorCanEditMedia('door', 'ACTIVE'), false);
  assert.equal(vendorCanEditMedia('staff', 'ACTIVE'), false);
  assert.equal(vendorCanEditMedia('owner', 'SUSPENDED'), false);
  assert.equal(vendorCanEditMedia('owner', 'CLOSED'), false);
});

test('a menu belongs on a place, not a bookable, and video stays closed until object storage exists', () => {
  assert.equal(planUpload({ parent: 'bookable', kind: 'menu', existing: [] }).ok, false);
  assert.equal(planUpload({ parent: 'location', kind: 'video', existing: [] }).ok, false);
  const closed = planUpload({ parent: 'location', kind: 'video', existing: [] });
  assert.equal(closed.ok, false);
  if (!closed.ok) {
    assert.equal(mediaHttpStatus(closed.reason), 413);
    assert.equal(MEDIA_REFUSALS[closed.reason], 'Video uploads are not available yet');
  }
  assert.deepEqual(planUpload({ parent: 'location', kind: 'video', existing: [], storeConfigured: true }), {
    ok: true,
    kind: 'video',
    position: 0,
    replace: false,
  });
});

test('a second cover replaces the first rather than stacking', () => {
  const first = planUpload({ parent: 'location', kind: 'cover', existing: [] });
  assert.deepEqual(first, { ok: true, kind: 'cover', position: 0, replace: false });
  const second = planUpload({
    parent: 'location',
    kind: 'cover',
    existing: [{ kind: 'cover', position: 0 }],
  });
  assert.deepEqual(second, { ok: true, kind: 'cover', position: 0, replace: true });
});

test('a place gallery stops at eight and a bookable gallery at three', () => {
  const fullPlace = Array.from({ length: MEDIA_CAPS.gallery.location }, (_, position) => ({
    kind: 'gallery' as const,
    position,
  }));
  const place = planUpload({ parent: 'location', kind: 'gallery', existing: fullPlace });
  assert.equal(place.ok, false);
  if (!place.ok) assert.equal(place.reason, 'at-capacity');

  const fullSku = Array.from({ length: MEDIA_CAPS.gallery.bookable }, (_, position) => ({
    kind: 'gallery' as const,
    position,
  }));
  const sku = planUpload({ parent: 'bookable', kind: 'gallery', existing: fullSku });
  assert.equal(sku.ok, false);
  if (!sku.ok) assert.equal(mediaHttpStatus(sku.reason), 409);
});

test('gallery appends into the first free slot', () => {
  const plan = planUpload({
    parent: 'location',
    kind: 'gallery',
    existing: [
      { kind: 'gallery', position: 0 },
      { kind: 'gallery', position: 2 },
    ],
  });
  assert.deepEqual(plan, { ok: true, kind: 'gallery', position: 1, replace: false });
});

test('a jpeg still and a pdf menu parse; svg and video data URIs do not', () => {
  const image = parseVendorMediaDataUri('cover', jpegUri);
  assert.equal(image.ok, true);

  const menu = parseVendorMediaDataUri('menu', pdfUri);
  assert.equal(menu.ok, true);

  const svg = parseVendorMediaDataUri('cover', 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(svg.ok, false);

  const video = parseVendorMediaDataUri('video', 'data:video/mp4;base64,AAAA');
  assert.equal(video.ok, false);
  if (!video.ok) assert.equal(video.reason, 'video-unavailable');
});

test('a video intent is an MP4, WebM, or QuickTime under 80 MB, never a data URI', () => {
  assert.deepEqual(planVideoUpload({ mimeType: 'video/mp4', byteSize: 12 }), { ok: true });
  assert.equal(planVideoUpload({ mimeType: 'video/avi', byteSize: 12 }).ok, false);
  const huge = planVideoUpload({ mimeType: 'video/mp4', byteSize: 80_000_001 });
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.reason, 'too-large');
});

test('bytes that do not match the declared type are refused', () => {
  const forged = `data:image/png;base64,${jpeg.toString('base64')}`;
  const parsed = parseVendorMediaDataUri('cover', forged);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.reason, 'bad-payload');
});

test('object keys nest seller, parent, kind, and id — never a public URL', () => {
  assert.equal(
    vendorObjectKey({
      sellerId: 'sel_1',
      parent: 'location',
      parentId: 'loc_1',
      kind: 'cover',
      mediaId: 'med_1',
    }),
    'vendor/sel_1/location/loc_1/cover/med_1',
  );
});
