import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../lib/db';
import { requireVendorSeat } from '../middleware/vendorAuth';
import { roleCapabilities, roleScope, type SeatRole } from '../vendor/contract';
import { handleMenuDishes } from './vendorMenuDishes';

const version = '2026-10-17T12:00:00.000Z';
let seat: any, location: any, media: any, count: number, changed: number;
let writes: any[], tx: any;
const originalTransaction = db.$transaction;
beforeEach(() => {
  seat = { id: 'seat', sellerId: 'seller', userId: 'user', state: 'ACTIVE', role: 'owner', locationIds: ['location'] };
  location = { id: 'location', sellerId: 'seller', state: 'ACTIVE', menuVenueId: 'venue', seller: { state: 'ACTIVE' } };
  media = { id: 'media' }; count = 0; changed = 1; writes = [];
  tx = {
    vendorSeat: { findFirst: async () => seat },
    vendorLocation: { findFirst: async ({ where }: any) => { assert.equal(where.sellerId, 'seller'); return location; }, findUnique: async () => location },
    vendorMedia: { findFirst: async ({ where }: any) => {
      assert.deepEqual(where, { id: 'media', sellerId: 'seller', locationId: 'location', bookableId: null, kind: 'menu' }); return media;
    } },
    vendorMenuDish: {
      count: async () => count, findMany: async () => [],
      create: async (args: any) => { writes.push({ op: 'create', ...args }); return {}; },
      updateMany: async (args: any) => { writes.push({ op: 'update', ...args }); return { count: changed }; },
      deleteMany: async (args: any) => { writes.push({ op: 'delete', ...args }); return { count: changed }; },
    },
  };
  (db as any).$transaction = async (run: any, options: any) => {
    assert.equal(options.isolationLevel, 'Serializable'); return run(tx);
  };
});
afterEach(() => { (db as any).$transaction = originalTransaction; mock.restoreAll(); });
function response() {
  const out = { status: 200, body: null as any, headers: {} as Record<string, unknown> };
  const res = { status(code: number) { out.status = code; return res; }, json(body: unknown) { out.body = body; return res; },
    setHeader(key: string, value: unknown) { out.headers[key] = value; return res; } };
  return { out, res: res as unknown as Response };
}
async function request(action: 'list' | 'save' | 'withdraw', body: unknown = {}) {
  const { out, res } = response();
  const req = { params: { id: 'location', dishId: 'dish' }, body,
    vendor: { userId: 'user', seller: { id: 'seller' }, seat: { id: 'seat' } } } as unknown as Request;
  await handleMenuDishes(req, res, action);
  return out;
}
const body = { mediaId: 'media', dishName: 'Jollof rice' };

test('route middleware refuses anonymous callers before any data access', async () => {
  const { out, res } = response();
  await requireVendorSeat({ headers: {} } as Request, res, () => assert.fail('anonymous entered route'));
  assert.equal(out.status, 401);
  assert.equal(writes.length, 0);
});

test('vendor create always starts pending and returns the list DTO', async () => {
  const result = await request('save', body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { venueId: 'venue', dishes: [] });
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(writes[0].data.reviewStatus, 'pending');
  assert.equal(writes[0].data.reviewedVenueId, null);
  assert.equal(writes[0].data.sourceUpdatedAt, null);
  assert.deepEqual(writes[0].data.aliases, []);
});

test('list source URL pins the exact media revision, not the dish revision', async () => {
  const mediaVersion = new Date(Date.parse(version) + 1);
  tx.vendorMenuDish.findMany = async () => [{ id: 'dish', mediaId: 'media', dishName: 'Rice', aliases: [],
    reviewStatus: 'pending', reviewNote: null, reviewedAt: null, updatedAt: new Date(version),
    media: { updatedAt: mediaVersion, reviewStatus: 'approved' } }];
  const result = await request('list');
  assert.equal(result.status, 200);
  assert.ok(result.body.dishes[0].sourceUrl.endsWith(`/media/menu-source/media/${mediaVersion.getTime()}`));
  assert.equal(result.body.dishes[0].mediaUpdatedAt, mediaVersion.toISOString());
});

test('strict objects prevent forged approvals, bindings and unknown fields', async () => {
  for (const extra of [{ reviewStatus: 'approved' }, { venueId: 'venue' }, { reviewedAt: version }, { anything: true }]) {
    assert.equal((await request('save', { ...body, ...extra })).status, 400);
  }
  assert.equal(writes.length, 0);
});

test('updates and withdrawal compare the exact version and location; edits reset review', async () => {
  assert.equal((await request('save', { ...body, dishId: 'dish' })).status, 400);
  assert.equal((await request('save', { ...body, dishId: 'dish', expectedUpdatedAt: version })).status, 200);
  assert.deepEqual(writes[0].where, { id: 'dish', locationId: 'location', updatedAt: new Date(version) });
  assert.equal(writes[0].data.reviewedAt, null);
  changed = 0;
  assert.equal((await request('save', { ...body, dishId: 'dish', expectedUpdatedAt: version })).status, 409);
  assert.equal((await request('withdraw', { expectedUpdatedAt: version })).status, 409);
  assert.deepEqual(writes.at(-1).where, { id: 'dish', locationId: 'location', updatedAt: new Date(version) });
  changed = 1;
  assert.equal((await request('withdraw', { expectedUpdatedAt: version })).status, 200);
  assert.equal((await request('withdraw', {})).status, 400);
});

test('fresh authorization rejects revoked seats, missing PUBLISH, unassigned and foreign locations', async () => {
  seat = null;
  assert.equal((await request('save', body)).status, 403);
  seat = { role: 'door', locationIds: ['location'] };
  assert.equal((await request('save', body)).status, 403);
  const roles: SeatRole[] = ['owner', 'manager', 'staff', 'door', 'serviceProvider'];
  for (const role of roles.filter((r) => roleScope(r) === 'assigned' && roleCapabilities(r).includes('PUBLISH'))) {
    seat = { role, locationIds: [] };
    assert.equal((await request('save', body)).status, 404);
  }
  seat = { role: 'owner', locationIds: [] }; location = null;
  assert.equal((await request('list')).status, 404);
  assert.equal(writes.length, 0);
});

test('suspended/closed businesses and closed places cannot write, including withdrawal', async () => {
  for (const state of ['SUSPENDED', 'CLOSED']) {
    location.seller.state = state;
    assert.equal((await request('save', body)).status, 403);
    assert.equal((await request('withdraw', { expectedUpdatedAt: version })).status, 403);
  }
  location.seller.state = 'ACTIVE'; location.state = 'CLOSED';
  assert.equal((await request('save', body)).status, 403);
  assert.equal(writes.length, 0);
});

test('missing/cross-seller/bookable source and the 100-dish cap fail before writing', async () => {
  media = null;
  assert.equal((await request('save', body)).status, 404);
  media = { id: 'media' }; count = 100;
  assert.equal((await request('save', body)).status, 409);
  assert.equal(writes.length, 0);
});
