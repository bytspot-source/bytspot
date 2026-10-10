import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
// Nobody has blocked anybody unless a test says so.
(db.userBlock as any).findMany = async () => [];
(db.userBlock as any).findFirst = async () => null;
const sale = db.privateSale as any;
const request = db.privateSaleRequest as any;
const handle = db.sellerPaymentHandle as any;
const user = db.user as any;

const as = (userId: string | null): Context => ({
  user: userId ? { userId, email: `${userId}@bytspot.com` } : null,
  clientRateLimitKey: `test-sales-${userId ?? 'anon'}`,
});
const seller = () => createCaller(as('seller-id'));
const buyer = () => createCaller(as('buyer-id'));
const anonymous = () => createCaller(as(null));

const hour = 3_600_000;
const openSale = () => ({
  id: 'sale-1', sellerId: 'seller-id', title: 'Jordan 4 Retro, size 10', priceCents: 22_000,
  providers: ['venmo'], meetPlaceName: 'Colony Square plaza', meetLat: 33.78786, meetLng: -84.38319,
  meetAreaLabel: 'Midtown', windowStart: new Date(Date.now() + hour), windowEnd: new Date(Date.now() + 3 * hour),
  buyerLimit: 1, status: 'open', closedAt: null, seller: { name: 'Kojo Mensah' },
});

let saleWhere: any;
let tier = 'green';
beforeEach(() => {
  tier = 'green';
  user.findUnique = async () => ({ membershipTier: tier });
  resetLocalRateLimitForTests();
  saleWhere = null;
  sale.findFirst = async ({ where }: any) => { saleWhere = where; return openSale(); };
  sale.count = async () => 0;
  sale.create = async ({ data }: any) => ({ id: 'sale-new', ...data });
  sale.update = async ({ data }: any) => ({ ...openSale(), ...data });
  request.findUnique = async () => null;
  request.findFirst = async () => null;
  request.count = async () => 0;
  request.create = async ({ data }: any) => ({ id: 'req-1', status: 'pending', ...data });
  request.update = async ({ data }: any) => ({ id: 'req-1', ...data });
  request.updateMany = async () => ({ count: 1 });
  handle.findMany = async ({ where }: any) => [{ provider: 'venmo', handle: 'Kojo-Mensah', displayName: 'Kojo Mensah', confirmedAt: new Date() }]
    .filter((h) => !where.provider || where.provider.in.includes(h.provider));
  handle.upsert = async ({ create }: any) => create;
  handle.updateMany = async () => ({ count: 1 });
});

test('a handle is saved only in its provider form and only with both confirmations', async () => {
  const saved = await seller().sales.handles.save({ provider: 'venmo', handle: '@Kojo-Mensah', displayName: 'Kojo Mensah', ownershipConfirmed: true, goodsAndServices: true });
  assert.equal(saved.handle, 'Kojo-Mensah');
  assert.equal(saved.url, 'https://venmo.com/u/Kojo-Mensah');
  await assert.rejects(() => seller().sales.handles.save({ provider: 'venmo', handle: '@ko', displayName: 'K', ownershipConfirmed: true, goodsAndServices: true }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => seller().sales.handles.save({ provider: 'venmo', handle: '@Kojo-Mensah', displayName: 'K', ownershipConfirmed: false as any, goodsAndServices: true }), { code: 'BAD_REQUEST' });
});

test('a sale needs a saved handle per provider, a valid window and room under the open cap', async () => {
  const input = {
    title: 'Jordan 4 Retro, size 10', priceCents: 22_000,
    meetPoint: { lat: 33.787861, lng: -84.383191, placeName: 'Colony Square plaza', areaLabel: 'Midtown' },
    windowStart: new Date(Date.now() + hour), windowEnd: new Date(Date.now() + 3 * hour), providers: ['venmo' as const],
  };
  let created: any;
  sale.create = async ({ data }: any) => { created = data; return { id: 'sale-new', ...data }; };
  assert.deepEqual(await seller().sales.create(input), { saleId: 'sale-new', shareUrl: 'https://bytspot.app/sale/sale-new' });
  assert.notEqual(created.meetLat, input.meetPoint.lat, 'the exact spot is never stored');
  assert.equal(created.buyerLimit, 1);

  await assert.rejects(() => seller().sales.create({ ...input, providers: ['venmo', 'paypal'] }), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(() => seller().sales.create({ ...input, windowEnd: new Date(Date.now() + 6 * hour) }), { code: 'BAD_REQUEST' });
});

test('membership sets how many sales stay open and how many buyers each allows', async () => {
  const input = {
    title: 'Jordan 4 Retro, size 10', priceCents: 22_000,
    meetPoint: { lat: 33.787861, lng: -84.383191, placeName: 'Colony Square plaza' },
    windowStart: new Date(Date.now() + hour), windowEnd: new Date(Date.now() + 3 * hour), providers: ['venmo' as const],
  };
  let open = 1;
  sale.count = async () => open;
  await assert.rejects(() => seller().sales.create(input), { code: 'FORBIDDEN', message: /1 open sale at a time/ });
  open = 0;
  await assert.rejects(() => seller().sales.create({ ...input, buyerLimit: 2 }), { code: 'FORBIDDEN', message: /1 buyer per sale/ });

  tier = 'platinum';
  open = 4;
  assert.ok(await seller().sales.create({ ...input, buyerLimit: 3 }));
  await assert.rejects(() => seller().sales.create({ ...input, buyerLimit: 4 }), { code: 'FORBIDDEN' });
  open = 5;
  await assert.rejects(() => seller().sales.create(input), { code: 'FORBIDDEN', message: /5 open sales/ });

  tier = 'black';
  open = 500;
  assert.ok(await seller().sales.create({ ...input, buyerLimit: 5 }));

  sale.findMany = async () => [];
  assert.deepEqual((await seller().sales.mine()).limits, { tier: 'black', openSales: null, buyersPerSale: 5 });
  tier = 'unknown';
  assert.deepEqual((await seller().sales.mine()).limits, { tier: 'green', openSales: 1, buyersPerSale: 1 });
});

test('a share link never shows the meet point, and shows the area only when signed in', async () => {
  const signedOut = await anonymous().sales.view({ saleId: 'sale-1' });
  assert.equal(signedOut.areaLabel, null);
  assert.equal(signedOut.sellerName, 'Kojo');
  assert.deepEqual(saleWhere.seller, { deletedAt: null, suspendedAt: null });
  assert.equal(saleWhere.moderationHiddenAt, null, 'a sale hidden by reports reads as gone');
  assert.equal(saleWhere.status, 'open');
  assert.ok(saleWhere.windowEnd.gt instanceof Date);
  const signedIn = await buyer().sales.view({ saleId: 'sale-1' });
  assert.equal(signedIn.areaLabel, 'Midtown');
  for (const view of [signedOut, signedIn]) {
    const text = JSON.stringify(view);
    assert.ok(!text.includes('33.78') && !text.includes('Colony Square') && !text.includes('seller-id'));
  }
});

test('a block either way makes the sale read as gone to that member only', async () => {
  (db.userBlock as any).findFirst = async () => ({ id: 'block-1' });
  try {
    await assert.rejects(() => buyer().sales.view({ saleId: 'sale-1' }), { code: 'NOT_FOUND' });
    await assert.rejects(() => buyer().sales.request({ saleId: 'sale-1' }), { code: 'NOT_FOUND' });
    await assert.rejects(() => buyer().sales.buyerCard({ saleId: 'sale-1' }), { code: 'NOT_FOUND' });
    assert.equal((await anonymous().sales.view({ saleId: 'sale-1' })).title, 'Jordan 4 Retro, size 10');
  } finally {
    (db.userBlock as any).findFirst = async () => null;
  }
});

test('an ended, sold, cancelled or missing sale reads the same as one that never existed', async () => {
  sale.findFirst = async () => null;
  for (const call of [
    () => anonymous().sales.view({ saleId: 'sale-1' }),
    () => buyer().sales.request({ saleId: 'sale-1' }),
    () => buyer().sales.buyerCard({ saleId: 'sale-1' }),
  ]) await assert.rejects(call, { code: 'NOT_FOUND', message: 'This sale is not available.' });
});

test('only an approved buyer gets the meet point and the pay buttons', async () => {
  await assert.rejects(() => buyer().sales.buyerCard({ saleId: 'sale-1' }), { code: 'NOT_FOUND' });
  request.findUnique = async () => ({ status: 'pending', arrivedAt: null });
  await assert.rejects(() => buyer().sales.buyerCard({ saleId: 'sale-1' }), { code: 'NOT_FOUND' });
  request.findUnique = async () => ({ status: 'declined', arrivedAt: null });
  await assert.rejects(() => buyer().sales.buyerCard({ saleId: 'sale-1' }), { code: 'NOT_FOUND' });

  request.findUnique = async () => ({ status: 'approved', arrivedAt: null });
  const card = await buyer().sales.buyerCard({ saleId: 'sale-1' });
  assert.equal(card.meetPoint.placeName, 'Colony Square plaza');
  assert.deepEqual(card.pay.map((p) => [p.provider, p.url, p.label]), [['venmo', 'https://venmo.com/u/Kojo-Mensah', 'Seller-confirmed handle']]);
  assert.match(card.pay[0].reminder, /doesn't process or protect/);
});

test('a buyer asks once; the seller approves up to the buyer limit', async () => {
  await assert.rejects(() => seller().sales.request({ saleId: 'sale-1' }), { code: 'BAD_REQUEST' });
  assert.deepEqual(await buyer().sales.request({ saleId: 'sale-1' }), { status: 'pending' });
  request.findUnique = async () => ({ status: 'declined' });
  assert.deepEqual(await buyer().sales.request({ saleId: 'sale-1' }), { status: 'declined' });

  // Not the caller's sale: the request is invisible.
  await assert.rejects(() => buyer().sales.approve({ requestId: 'req-1' }), { code: 'NOT_FOUND' });
  let requestWhere: any;
  request.findFirst = async ({ where }: any) => { requestWhere = where; return { id: 'req-1', status: 'pending', sale: { id: 'sale-1', buyerLimit: 1 } }; };
  assert.deepEqual(await seller().sales.approve({ requestId: 'req-1' }), { status: 'approved' });
  assert.equal(requestWhere.sale.sellerId, 'seller-id');
  request.count = async () => 1;
  await assert.rejects(() => seller().sales.approve({ requestId: 'req-1' }), { code: 'CONFLICT' });
  assert.deepEqual(await seller().sales.decline({ requestId: 'req-1' }), { status: 'declined' });
});

test('closing a sale is final and repeatable', async () => {
  let data: any;
  sale.update = async (args: any) => { data = args.data; return {}; };
  assert.deepEqual(await seller().sales.close({ saleId: 'sale-1', outcome: 'sold' }), { saleId: 'sale-1', state: 'sold' });
  assert.equal(data.status, 'sold');
  assert.ok(data.closedAt instanceof Date);
  sale.findFirst = async () => ({ ...openSale(), status: 'sold' });
  assert.deepEqual(await seller().sales.close({ saleId: 'sale-1', outcome: 'cancelled' }), { saleId: 'sale-1', state: 'sold' });
});
