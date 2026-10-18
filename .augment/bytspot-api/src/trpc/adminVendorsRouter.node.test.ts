import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { db } from '../lib/db';
import { adminVendorsRouter } from './adminVendorsRouter';
import { resetLocalRateLimitForTests } from './trpc';

const originalTransaction = db.$transaction;
const restores: Array<() => void> = [];
function stubModel(target: any, key: string, implementation: (...args: any[]) => any) {
  const original = target[key]; target[key] = implementation;
  restores.push(() => { target[key] = original; });
}
const version = '2026-10-17T12:00:00.000Z';
const review = { dishId: 'dish', approve: true, expectedUpdatedAt: version, expectedMediaUpdatedAt: version, expectedVenueId: 'venue' };
let previousAdmins: string, previousRedis: typeof config.redisUrl, writes: any[], row: any, location: any, venue: any, changed: number;
const caller = (userId = 'menu-admin') => adminVendorsRouter.createCaller({
  user: { userId, email: `${userId}@example.test` }, clientRateLimitKey: `menu-${userId}`,
});
beforeEach(() => {
  previousAdmins = config.adminUserIds;
  previousRedis = config.redisUrl;
  (config as any).redisUrl = ''; // No Redis/network writes, even with a configured developer environment.
  (config as any).adminUserIds = 'menu-admin:BYTSPOT_ADMIN';
  resetLocalRateLimitForTests();
  mock.method(console, 'log', () => {});
  writes = []; changed = 1; venue = { id: 'venue', discoverable: true };
  location = { id: 'location', label: 'Kitchen', address: '1 Example Street', sellerId: 'seller', state: 'ACTIVE', menuVenueId: 'venue',
    seller: { state: 'ACTIVE', legalName: 'Kitchen' }, menuVenue: { name: 'Kitchen', address: '1 Example Street', discoverable: true } };
  row = { id: 'dish', locationId: 'location', mediaId: 'media', dishName: 'Jollof rice', aliases: [],
    reviewStatus: 'pending', reviewedAt: null, reviewNote: null, createdAt: new Date(version), updatedAt: new Date(version), location,
    media: { id: 'media', kind: 'menu', locationId: 'location', sellerId: 'seller', bookableId: null, reviewStatus: 'approved',
      updatedAt: new Date(version), byteSize: 4, bytes: Buffer.from('menu'), storageKey: null } };
  (db as any).$transaction = async (run: any, options: any) => {
    assert.equal(options.isolationLevel, 'Serializable'); return run(db);
  };
  stubModel(db.vendorLocation, 'findUnique', async () => location);
  stubModel(db.vendorLocation, 'updateMany', async (args: any) => { writes.push({ op: 'bind', ...args }); return { count: changed }; });
  stubModel(db.venue, 'findFirst', async () => venue);
  stubModel(db.vendorMenuDish, 'findUnique', async () => row);
  stubModel(db.vendorMenuDish, 'updateMany', async (args: any) => { writes.push({ op: 'review', ...args }); return { count: changed }; });
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  (db as any).$transaction = originalTransaction; mock.restoreAll();
  (config as any).adminUserIds = previousAdmins; (config as any).redisUrl = previousRedis;
});

test('all menu procedures enforce admin identity and anonymous callers fail authentication', async () => {
  for (const client of [caller('guest'), adminVendorsRouter.createCaller({ user: null, clientRateLimitKey: 'menu-anonymous' })]) {
    for (const run of [() => client.menuQueue(), () => client.menuVenues({ query: 'Kitchen' }),
      () => client.linkMenuVenue({ locationId: 'location', venueId: null, expectedVenueId: 'venue' }), () => client.reviewMenuDish(review)]) {
      await assert.rejects(run, (error: any) => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code));
    }
  }
  assert.equal(writes.length, 0);
});

test('queue defaults pending, returns exact versioned DTO and excludes business contact details', async () => {
  stubModel(db.vendorMenuDish, 'findMany', async (args: any) => {
    assert.equal(args.take, 200); assert.equal(args.where.reviewStatus, 'pending'); return [row];
  });
  const result = await caller().menuQueue();
  assert.equal(result.dishes[0].venueId, 'venue');
  assert.equal(result.dishes[0].venueDiscoverable, true);
  assert.equal(result.dishes[0].mediaUpdatedAt, version);
  assert.equal(result.dishes[0].updatedAt, version);
  assert.equal(result.dishes[0].business, 'Kitchen');
  assert.equal('seller' in result.dishes[0], false);
  assert.equal('bytes' in result.dishes[0], false);
  assert.equal('contactEmail' in result.dishes[0], false);
  assert.ok(result.dishes[0].sourceUrl.endsWith(`/media/menu-source/media/${Date.parse(version)}`));
});

test('venue lookup only searches existing discoverable names/addresses, caps at twenty', async () => {
  stubModel(db.venue, 'findMany', async (args: any) => {
    assert.deepEqual(args.where, { discoverable: true, OR: [
      { name: { contains: 'Kitchen', mode: 'insensitive' } }, { address: { contains: 'Kitchen', mode: 'insensitive' } },
    ] });
    assert.equal(args.take, 20); return [{ id: 'venue', name: 'Kitchen', address: '1 Example Street' }];
  });
  assert.deepEqual(await caller().menuVenues({ query: 'Kitchen' }), { venues: [{ venueId: 'venue', name: 'Kitchen', address: '1 Example Street' }] });
  await assert.rejects(() => caller().menuVenues({ query: 'x' }), { code: 'BAD_REQUEST' });
});

test('binding is explicit CAS; changes reset every dish inside the same transaction', async () => {
  await assert.rejects(() => caller().linkMenuVenue({ locationId: 'location', venueId: 'new', expectedVenueId: null }), { code: 'CONFLICT' });
  assert.equal(writes.length, 0);
  assert.deepEqual(await caller().linkMenuVenue({ locationId: 'location', venueId: null, expectedVenueId: 'venue' }), { venueId: null });
  assert.deepEqual(writes[0].where, { id: 'location', menuVenueId: 'venue', state: 'ACTIVE' });
  assert.deepEqual(writes[1].where, { locationId: 'location' });
  assert.equal(writes[1].data.reviewStatus, 'pending');
  assert.equal(writes[1].data.sourceUpdatedAt, null);
  writes = [];
  await caller().linkMenuVenue({ locationId: 'location', venueId: 'venue', expectedVenueId: 'venue' });
  assert.equal(writes.length, 0, 'no-op does not revoke reviews');
});

test('nullable binding audit details use a typed non-null sentinel', async () => {
  const lines: string[] = [];
  mock.method(console, 'log', (line: string) => { lines.push(line); });
  await caller().linkMenuVenue({ locationId: 'location', venueId: null, expectedVenueId: 'venue' });
  const audit = lines.map((line) => JSON.parse(line)).find((line) => line.action === 'admin.vendors.linkMenuVenue');
  assert.equal(audit.venueId, 'unbound');
  assert.equal(audit.previousVenueId, 'venue');
  row.location.menuVenueId = null;
  await caller().reviewMenuDish({ ...review, approve: false, expectedVenueId: null });
  const rejected = lines.map((line) => JSON.parse(line)).find((line) => line.action === 'admin.vendors.reviewMenuDish');
  assert.equal(rejected.venueId, 'unbound');
});

test('hidden venues, inactive places and an already-bound canonical venue refuse binding', async () => {
  venue = null;
  await assert.rejects(() => caller().linkMenuVenue({ locationId: 'location', venueId: 'hidden', expectedVenueId: 'venue' }), { code: 'CONFLICT' });
  venue = { id: 'new' }; location.state = 'PAUSED';
  await assert.rejects(() => caller().linkMenuVenue({ locationId: 'location', venueId: 'new', expectedVenueId: 'venue' }), { code: 'CONFLICT' });
  location.state = 'ACTIVE';
  stubModel(db.vendorLocation, 'updateMany', async () => {
    throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
  });
  await assert.rejects(() => caller().linkMenuVenue({ locationId: 'location', venueId: 'new', expectedVenueId: 'venue' }), { code: 'CONFLICT' });
});

test('review snapshots explicit source and venue versions, reviewer and date, and permits fresh reapproval', async () => {
  assert.deepEqual(await caller().reviewMenuDish(review), { reviewStatus: 'approved' });
  assert.equal(writes[0].data.reviewedByUserId, 'menu-admin');
  assert.equal(writes[0].data.reviewedVenueId, 'venue');
  assert.deepEqual(writes[0].data.sourceUpdatedAt, new Date(version));
  assert.ok(writes[0].data.reviewedAt instanceof Date);
  assert.deepEqual(writes[0].where.media, { updatedAt: new Date(version) });
  row.reviewStatus = 'approved';
  await caller().reviewMenuDish(review);
  assert.equal(writes.length, 2);
  await caller().reviewMenuDish({ ...review, approve: false, note: 'Not on the uploaded menu' });
  assert.equal(writes[2].data.reviewStatus, 'rejected');
  assert.equal(writes[2].data.reviewNote, 'Not on the uploaded menu');
});

test('dish edits, media replacement, binding changes and a lost review CAS all conflict', async () => {
  for (const input of [{ ...review, expectedUpdatedAt: new Date(0).toISOString() },
    { ...review, expectedMediaUpdatedAt: new Date(0).toISOString() }, { ...review, expectedVenueId: null }]) {
    await assert.rejects(() => caller().reviewMenuDish(input), { code: 'CONFLICT' });
  }
  assert.equal(writes.length, 0);
  changed = 0;
  await assert.rejects(() => caller().reviewMenuDish(review), { code: 'CONFLICT' });
});

test('approval requires active seller/location, discoverable binding and uploaded approved menu', async () => {
  for (const mutate of [() => { row.media.reviewStatus = 'pending'; }, () => { row.media.bytes = Buffer.alloc(0); row.media.byteSize = 0; },
    () => { row.location.seller.state = 'SUSPENDED'; }, () => { row.location.state = 'CLOSED'; },
    () => { row.location.menuVenue.discoverable = false; }, () => { row.media.sellerId = 'other'; }]) {
    const original = structuredClone(row);
    mutate();
    await assert.rejects(() => caller().reviewMenuDish(review), { code: 'CONFLICT' });
    row = original;
  }
  assert.equal(writes.length, 0);
});
