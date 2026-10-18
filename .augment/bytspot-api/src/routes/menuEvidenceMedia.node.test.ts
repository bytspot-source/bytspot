import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../lib/db';
import { memoryObjectStore, objectStoreHandle } from '../lib/objectStore';
import { signVendorAccessToken } from '../vendor/accessToken';
import { MENU_REVIEW_MS } from '../services/menuEvidence';
import { createMenuEvidenceMediaHandler } from './menuEvidenceMedia';
import { handleMenuSource, saveUpload } from './vendorMedia';

const now = new Date('2026-10-18T12:00:00.000Z');
const revision = String(now.getTime());
const pdf = Buffer.from('%PDF-1.4 menu');
function dish(): any {
  return { id: 'dish', mediaId: 'media', locationId: 'location', updatedAt: now,
    reviewStatus: 'approved', reviewedAt: now, reviewedByUserId: 'admin', reviewedVenueId: 'venue', sourceUpdatedAt: now,
    media: { id: 'media', sellerId: 'seller', locationId: 'location', bookableId: null, kind: 'menu',
      updatedAt: now, reviewStatus: 'approved', mimeType: 'application/pdf', byteSize: pdf.length, bytes: pdf, storageKey: null },
    location: { id: 'location', sellerId: 'seller', state: 'ACTIVE', menuVenueId: 'venue',
      seller: { state: 'ACTIVE' }, menuVenue: { id: 'venue', discoverable: true } } };
}
function response() {
  const out = { status: 200, body: undefined as any, headers: {} as Record<string, unknown> };
  const res = { status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; }, send(body: unknown) { out.body = body; return res; },
    setHeader(key: string, value: unknown) { out.headers[key] = value; return res; },
    redirect() { assert.fail('Revision sources must never redirect'); } };
  return { out, res: res as unknown as Response };
}
function request(version = revision, authorization?: string): Request {
  return { params: { dishId: 'dish', mediaId: 'media', revision: version }, headers: { authorization } } as unknown as Request;
}
function privateResponse(out: ReturnType<typeof response>['out']) {
  assert.equal(out.headers['Cache-Control'], 'private, no-store');
  assert.equal(out.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(out.headers.Location, undefined);
}
const restores: Array<() => void> = [];
function replace(target: any, key: string, value: any) {
  const original = target[key]; target[key] = value;
  restores.push(() => { target[key] = original; });
}
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

async function guest(row: any, version = revision, readObject: (key: string | null | undefined) => Promise<Buffer | null> = async () => null) {
  const { out, res } = response();
  await createMenuEvidenceMediaHandler({ loadDish: async () => row, readObject, now: () => now })(request(version), res);
  privateResponse(out);
  return out;
}

test('guest source returns only bytes with allowed MIME, nosniff and no cache or redirect', async () => {
  for (const mimeType of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) {
    const row = dish(); row.media.mimeType = mimeType;
    const out = await guest(row);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, pdf);
    assert.equal(out.headers['Content-Type'], mimeType);
    assert.equal(out.headers['Content-Length'], String(pdf.length));
  }
  const row = dish(); row.media.bytes = null; row.media.storageKey = 'revision-object';
  let reads = 0;
  assert.equal((await guest(row, revision, async (key) => { reads++; assert.equal(key, 'revision-object'); return pdf; })).status, 200);
  assert.equal(reads, 1);
});

test('guest source review expiry is exclusive at thirty days', async () => {
  const row = dish(); row.reviewedAt = new Date(now.getTime() - MENU_REVIEW_MS + 1);
  assert.equal((await guest(row)).status, 200);
  row.reviewedAt = new Date(now.getTime() - MENU_REVIEW_MS);
  assert.equal((await guest(row)).status, 404);
});

test('guest source rejects noncanonical or stale revisions before storage access', async () => {
  for (const version of ['0' + revision, '+' + revision, revision + '.0', '1e12', 'NaN', '-1', '9007199254740992', String(now.getTime() - 1)]) {
    assert.equal((await guest(dish(), version, async () => { assert.fail('must not read storage'); })).status, 404, version);
  }
});

const invalidations: Array<[string, (row: any) => void]> = [
  ['pending dish', (r) => { r.reviewStatus = 'pending'; }],
  ['rejected dish', (r) => { r.reviewStatus = 'rejected'; }],
  ['withdrawn dish', (r) => { r.reviewStatus = 'withdrawn'; }],
  ['pending media', (r) => { r.media.reviewStatus = 'pending'; }],
  ['rejected media', (r) => { r.media.reviewStatus = 'rejected'; }],
  ['replacement', (r) => { r.media.updatedAt = new Date(now.getTime() + 1); }],
  ['dish edit', (r) => { r.updatedAt = new Date(now.getTime() + 1); }],
  ['missing source version', (r) => { r.sourceUpdatedAt = null; }],
  ['hidden venue', (r) => { r.location.menuVenue.discoverable = false; }],
  ['suspended seller', (r) => { r.location.seller.state = 'SUSPENDED'; }],
  ['closed seller', (r) => { r.location.seller.state = 'CLOSED'; }],
  ['paused location', (r) => { r.location.state = 'PAUSED'; }],
  ['closed location', (r) => { r.location.state = 'CLOSED'; }],
  ['rebound venue', (r) => { r.location.menuVenueId = 'other'; }],
  ['unbound venue', (r) => { r.location.menuVenueId = null; r.location.menuVenue = null; }],
  ['wrong canonical venue', (r) => { r.location.menuVenue.id = 'other'; }],
  ['expired review', (r) => { r.reviewedAt = new Date(now.getTime() - MENU_REVIEW_MS); }],
  ['future review', (r) => { r.reviewedAt = new Date(now.getTime() + 1); }],
  ['missing reviewer', (r) => { r.reviewedByUserId = null; }],
  ['cross-owner media', (r) => { r.media.sellerId = 'other'; }],
  ['cross-location media', (r) => { r.media.locationId = 'other'; }],
  ['different media', (r) => { r.mediaId = 'other'; }],
  ['bookable media', (r) => { r.media.bookableId = 'window'; }],
  ['non-menu media', (r) => { r.media.kind = 'cover'; }],
  ['empty source', (r) => { r.media.bytes = null; r.media.storageKey = ' '; }],
  ['zero size', (r) => { r.media.byteSize = 0; }],
  ...['text/html', 'image/svg+xml', 'application/javascript', 'application/pdf; charset=utf-8', ''].map((mime): [string, (r: any) => void] =>
    [`unsafe MIME ${mime}`, (r) => { r.media.mimeType = mime; }]),
];

test('guest source fails closed for every revoked, stale or unsafe evidence state', async () => {
  for (const [label, invalidate] of invalidations) {
    const row = dish(); invalidate(row);
    assert.equal((await guest(row, revision, async () => { assert.fail('invalid evidence reached storage'); })).status, 404, label);
  }
  assert.equal((await guest(null)).status, 404, 'deleted dish');
  const row = dish(); row.media.bytes = null; row.media.storageKey = 'missing';
  assert.equal((await guest(row)).status, 404, 'deleted object');
  assert.equal((await guest(row, revision, async () => { throw new Error('storage unavailable'); })).status, 404);
});

test('every invalidation during the awaited object read is rechecked before sending bytes', async () => {
  for (const [label, invalidate] of invalidations) {
    let row = dish(); row.media.bytes = null; row.media.storageKey = 'old-revision';
    const { out, res } = response();
    await createMenuEvidenceMediaHandler({ loadDish: async () => structuredClone(row), now: () => now,
      readObject: async () => { invalidate(row); return pdf; } })(request(), res);
    assert.equal(out.status, 404, label); privateResponse(out);
  }
  for (const change of ['delete', 'expire']) {
    let row: any = dish(); row.media.bytes = null; row.media.storageKey = 'old-revision';
    let clock = now;
    const { out, res } = response();
    await createMenuEvidenceMediaHandler({ loadDish: async () => structuredClone(row), now: () => clock,
      readObject: async () => { if (change === 'delete') row = null; else clock = new Date(now.getTime() + MENU_REVIEW_MS); return pdf; } })(request(), res);
    assert.equal(out.status, 404, change); privateResponse(out);
  }
});

function previewRow(): any {
  const row = dish();
  return { ...row.media, location: row.location, seller: { state: 'ACTIVE', videoHostingAt: null }, bookable: null };
}
async function preview(version = revision, authorization?: string) {
  const { out, res } = response();
  await handleMenuSource(request(version, authorization), res); privateResponse(out); return out;
}

test('revision preview proxies object bytes, rejects mismatched/noncanonical revisions and unsafe MIME', async () => {
  let row = previewRow(); row.bytes = null; row.storageKey = 'preview-key';
  replace(db.vendorMedia, 'findUnique', async () => structuredClone(row));
  const store = memoryObjectStore();
  await store.put({ key: 'preview-key', bytes: pdf, mimeType: 'application/pdf' });
  store.presignGet = () => { assert.fail('preview must never presign'); };
  replace(objectStoreHandle, 'get', () => store);
  const out = await preview(); assert.equal(out.status, 200); assert.deepEqual(out.body, pdf);
  for (const version of [String(now.getTime() - 1), '0' + revision, revision + '.0']) assert.equal((await preview(version)).status, 404);
  for (const mime of ['text/html', 'image/svg+xml']) { row.mimeType = mime; assert.equal((await preview()).status, 404); }
  row = previewRow(); row.kind = 'cover'; assert.equal((await preview()).status, 404);
  row = null; assert.equal((await preview()).status, 404);
});

test('private revision preview requires an admin or an active vendor seat with location scope', async () => {
  let row = previewRow(); row.reviewStatus = 'pending';
  replace(db.vendorMedia, 'findUnique', async () => row);
  let seat: any = { role: 'serviceProvider', locationIds: [], bookableIds: [] };
  replace(db.vendorSeat, 'findFirst', async ({ where }: any) => {
    assert.equal(where.sellerId, 'seller'); assert.equal(where.state, 'ACTIVE'); return seat;
  });
  replace(config, 'adminUserIds', 'preview-admin:BYTSPOT_ADMIN');
  const vendorAuth = `Bearer ${signVendorAccessToken({ userId: 'vendor-user', email: 'vendor@example.test' })}`;
  const adminAuth = `Bearer ${jwt.sign({ userId: 'preview-admin', email: 'admin@example.test' }, config.jwtSecret)}`;
  for (const status of ['pending', 'rejected']) {
    row.reviewStatus = status;
    assert.equal((await preview()).status, 404);
    assert.equal((await preview(revision, vendorAuth)).status, 404);
    assert.equal((await preview(revision, adminAuth)).status, 200);
    assert.equal((await preview(String(now.getTime() - 1), adminAuth)).status, 404);
  }
  seat.locationIds = ['location']; assert.equal((await preview(revision, vendorAuth)).status, 200);
  seat = null; assert.equal((await preview(revision, vendorAuth)).status, 404);
  row = previewRow(); row.location.state = 'PAUSED'; assert.equal((await preview()).status, 404);
  row = previewRow(); row.seller.state = 'SUSPENDED'; assert.equal((await preview()).status, 404);
});

test('preview rechecks replacement, revocation and deletion after reading object storage', async () => {
  for (const change of ['replace', 'revoke', 'delete']) {
    let row: any = previewRow(); row.bytes = null; row.storageKey = 'preview-key';
    replace(db.vendorMedia, 'findUnique', async () => structuredClone(row));
    const store = memoryObjectStore();
    store.get = async () => {
      if (change === 'replace') row.updatedAt = new Date(now.getTime() + 1);
      else if (change === 'revoke') row.reviewStatus = 'rejected';
      else row = null;
      return pdf;
    };
    replace(objectStoreHandle, 'get', () => store);
    assert.equal((await preview()).status, 404, change);
  }
});

test('replacement upload uses a fresh object key and DB failure deletes only the new object', async () => {
  const store = memoryObjectStore();
  const oldKey = 'vendor/seller/location/location/menu/media';
  const oldBytes = Buffer.from('%PDF-1.4 old menu');
  await store.put({ key: oldKey, bytes: oldBytes, mimeType: 'application/pdf' });
  replace(objectStoreHandle, 'get', () => store);
  replace(db.vendorMedia, 'findMany', async () => [{ kind: 'menu', position: 0 }]);
  replace(db.vendorMedia, 'findFirst', async () => ({ id: 'media', storageKey: oldKey }));
  let nextKey = '';
  replace(db.vendorMedia, 'update', async ({ where, data }: any) => {
    assert.equal(where.id, 'media'); nextKey = data.storageKey;
    assert.notEqual(nextKey, oldKey);
    assert.deepEqual(await store.get(oldKey), oldBytes, 'old bytes remain intact before DB commit');
    assert.deepEqual(await store.get(nextKey), pdf);
    throw new Error('DB update failed');
  });
  const { res } = response();
  const req = { body: { kind: 'menu', position: 0, dataUri: `data:application/pdf;base64,${pdf.toString('base64')}` } } as Request;
  await assert.rejects(() => saveUpload(req, res, { seller: { id: 'seller', state: 'ACTIVE' },
    seat: { role: 'owner', locationIds: [], bookableIds: [] } } as any, 'location', 'location'), /DB update failed/);
  assert.ok(nextKey); assert.equal(await store.get(nextKey), null);
  assert.deepEqual(await store.get(oldKey), oldBytes);
});

test('successful replacements retain the media ID but never reuse an upload object key', async () => {
  const store = memoryObjectStore();
  let previousKey = 'vendor/seller/location/location/menu/media';
  await store.put({ key: previousKey, bytes: pdf, mimeType: 'application/pdf' });
  replace(objectStoreHandle, 'get', () => store);
  replace(db.vendorMedia, 'findMany', async () => [{ kind: 'menu', position: 0 }]);
  replace(db.vendorMedia, 'findFirst', async () => ({ id: 'media', storageKey: previousKey }));
  const keys = new Set([previousKey]);
  let committedKey = '';
  replace(db.vendorMedia, 'update', async ({ where, data }: any) => {
    assert.equal(where.id, 'media'); assert.equal(data.reviewStatus, 'pending');
    assert.equal(keys.has(data.storageKey), false); keys.add(data.storageKey);
    assert.deepEqual(await store.get(previousKey), pdf, 'old revision survives until DB commit');
    committedKey = data.storageKey;
    return { id: 'media', kind: 'menu', position: 0, ...data };
  });
  for (let i = 0; i < 2; i++) {
    const { out, res } = response();
    await saveUpload({ body: { kind: 'menu', position: 0, dataUri: `data:application/pdf;base64,${pdf.toString('base64')}` } } as Request,
      res, { seller: { id: 'seller', state: 'ACTIVE' }, seat: { role: 'owner', locationIds: [], bookableIds: [] } } as any, 'location', 'location');
    assert.equal(out.status, 200); assert.equal(out.body.media.id, 'media');
    assert.equal(await store.get(previousKey), null);
    assert.deepEqual(await store.get(committedKey), pdf);
    previousKey = committedKey;
  }
  assert.equal(keys.size, 3);
});
