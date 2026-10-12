import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import {
  BandRangeRefused,
  BandRefused,
  activateBand,
  assignBands,
  bandRange,
  bandRuns,
  editBand,
  linkBand,
  markBandLost,
  parseBandSerial,
  readBand,
  releaseBands,
} from './bands';

const vendorBand = db.vendorBand as any;
const vendorLocation = db.vendorLocation as any;
const vendorTicketOrder = db.vendorTicketOrder as any;

const now = new Date('2026-10-18T20:00:00Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'band-1', serial: 'BYT424-0301', sellerId: 'seller-1', locationId: null, tier: null, vendorCode: null,
    state: 'assigned', activatedAt: null, lostAt: null, location: null, ...over,
  };
}

function codeTaken() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
}

beforeEach(() => {
  vendorBand.findMany = async () => [];
  vendorBand.findFirst = async () => row();
  vendorBand.findUniqueOrThrow = async () => row({ state: 'active' });
  vendorBand.updateMany = async () => ({ count: 1 });
  vendorBand.createMany = async (input: any) => ({ count: input.data.length });
  vendorBand.count = async () => 0;
  vendorBand.deleteMany = async () => ({ count: 0 });
  vendorLocation.findFirst = async () => ({ id: 'loc-1' });
  vendorTicketOrder.findFirst = async () => ({ userId: 'guest-1', ticket: { locationId: 'loc-1' } });
  vendorTicketOrder.findMany = async () => [];
});

test('a band number reads the same typed, scanned or tapped', () => {
  for (const raw of [
    'BYT424-0301',
    ' byt424-0301 ',
    'BYT4240301',
    'BYT424-0301-b',
    'BYT424-0301G',
    'https://bytspot.app/BYT424-0301',
    'bytspot.app/BYT424-0301-P',
    'https://bytspot.app/p/BYT424-0301-B?tagUseMode=everyday',
    'https://bytspot.app/BYT424?patchId=BYT424-0301',
  ]) {
    assert.equal(parseBandSerial(raw), 'BYT424-0301', raw);
  }
  for (const raw of ['', 'BYT424', 'BYT424-301', 'BYT424-0301-X', 'ABC424-0301', 'https://bytspot.app/at/ABCD2345', 42, undefined]) {
    assert.equal(parseBandSerial(raw), undefined, String(raw));
  }
});

test('a range lists every band in it, padded the way the supplier prints them', () => {
  assert.deepEqual(bandRange('BYT424-0098', 'BYT424-0101'), ['BYT424-0098', 'BYT424-0099', 'BYT424-0100', 'BYT424-0101']);
  assert.equal(bandRange('BYT424-0301', 'BYT424-0600').length, 300);
  assert.deepEqual(bandRange('BYT424-0017', 'byt424-0017'), ['BYT424-0017']);
  assert.throws(() => bandRange('BYT424-0400', 'BYT424-0301'), BandRangeRefused);
  assert.throws(() => bandRange('BYT424-0301', 'BYT425-0400'), BandRangeRefused);
  assert.throws(() => bandRange('BYT424-0001', 'BYT424-2000'), BandRangeRefused);
  assert.throws(() => bandRange('table 4', 'BYT424-0400'), BandRangeRefused);
});

test('held bands are summarised as runs', () => {
  assert.deepEqual(bandRuns(['BYT424-0303', 'BYT424-0301', 'BYT424-0302', 'BYT424-0450', 'BYT425-0451']), [
    'BYT424-0301 – BYT424-0303',
    'BYT424-0450',
    'BYT425-0451',
  ]);
  assert.deepEqual(bandRuns([]), []);
});

test('a range is refused whole when another business holds any band in it', async () => {
  let created = false;
  vendorBand.findMany = async () => [{ serial: 'BYT424-0350', sellerId: 'seller-2' }, { serial: 'BYT424-0302', sellerId: 'seller-1' }];
  vendorBand.createMany = async () => { created = true; return { count: 0 }; };
  await assert.rejects(() => assignBands('seller-1', 'admin-1', 'BYT424-0301', 'BYT424-0400'), (err: any) => {
    assert.ok(err instanceof BandRangeRefused);
    assert.match(err.reason, /BYT424-0350/);
    return true;
  });
  assert.equal(created, false);
});

test('assigning again skips the bands the business already holds', async () => {
  let data: any[] = [];
  vendorBand.findMany = async () => [{ serial: 'BYT424-0301', sellerId: 'seller-1' }];
  vendorBand.createMany = async (input: any) => { data = input.data; assert.equal(input.skipDuplicates, true); return { count: input.data.length - 1 }; };
  assert.deepEqual(await assignBands('seller-1', 'admin-1', 'BYT424-0301', 'BYT424-0310'), { added: 9, alreadyHere: 1 });
  assert.equal(data.length, 10);
  assert.deepEqual(data[0], { serial: 'BYT424-0301', sellerId: 'seller-1', assignedByUserId: 'admin-1' });
});

test('releasing takes back only bands that were never activated', async () => {
  let where: any;
  vendorBand.count = async () => 10;
  vendorBand.deleteMany = async (input: any) => { where = input.where; return { count: 7 }; };
  assert.deepEqual(await releaseBands('seller-1', 'BYT424-0301', 'BYT424-0310'), { released: 7, kept: 3 });
  assert.equal(where.sellerId, 'seller-1');
  assert.equal(where.state, 'assigned');
});

const activation = { band: 'https://bytspot.app/BYT424-0301-b', locationId: 'loc-1', tier: 'black' as const };

test('another business\'s band reads as not yours', async () => {
  let where: any;
  vendorBand.findFirst = async (input: any) => { where = input.where; return null; };
  await assert.rejects(() => activateBand('seller-1', 'seat-1', activation, now), (err: any) => {
    assert.ok(err instanceof BandRefused);
    assert.equal(err.status, 404);
    return true;
  });
  assert.deepEqual(where, { serial: 'BYT424-0301', sellerId: 'seller-1' });
});

test('activating sets the place, the tier from the business, and who did it', async () => {
  let update: any;
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  const result = await activateBand('seller-1', 'seat-1', { ...activation, tier: 'green', vendorCode: 'VIP-017' }, now);
  assert.equal(result.alreadyActive, false);
  assert.deepEqual(update.where, { id: 'band-1', sellerId: 'seller-1', state: 'assigned' });
  assert.deepEqual(update.data, {
    state: 'active', locationId: 'loc-1', tier: 'green', vendorCode: 'VIP-017', activatedAt: now, activatedBySeatId: 'seat-1',
  });
});

test('activating an active band again is not an error', async () => {
  let updated = false;
  vendorBand.findFirst = async () => row({ state: 'active', tier: 'black' });
  vendorBand.updateMany = async () => { updated = true; return { count: 1 }; };
  const result = await activateBand('seller-1', 'seat-1', activation, now);
  assert.equal(result.alreadyActive, true);
  assert.equal(result.band.state, 'active');
  assert.equal(updated, false);
});

test('a lost band cannot be activated again', async () => {
  vendorBand.findFirst = async () => row({ state: 'lost' });
  await assert.rejects(() => activateBand('seller-1', 'seat-1', activation, now), BandRefused);
});

test('a band admits only to one of the business\'s own places', async () => {
  vendorLocation.findFirst = async () => null;
  await assert.rejects(() => activateBand('seller-1', 'seat-1', activation, now), /Choose one of your places/);
});

test('two bands cannot share a vendor code', async () => {
  vendorBand.updateMany = async () => { throw codeTaken(); };
  await assert.rejects(() => activateBand('seller-1', 'seat-1', { ...activation, vendorCode: 'VIP-017' }, now), /already uses that code/);
  vendorBand.findFirst = async () => row({ state: 'active' });
  await assert.rejects(() => editBand('seller-1', 'band-1', { vendorCode: 'VIP-017' }), /already uses that code/);
});

test('editing changes only what was sent, and a null code clears it', async () => {
  let data: any;
  vendorBand.findFirst = async () => row({ state: 'active' });
  vendorBand.updateMany = async (input: any) => { data = input.data; return { count: 1 }; };
  await editBand('seller-1', 'band-1', { tier: 'platinum', vendorCode: null });
  assert.deepEqual(data, { tier: 'platinum', vendorCode: null });
});

test('a lost band cannot be changed', async () => {
  vendorBand.findFirst = async () => row({ state: 'lost' });
  await assert.rejects(() => editBand('seller-1', 'band-1', { tier: 'black' }), /lost band cannot be changed/);
});

test('marking a band lost is final and scoped to the business', async () => {
  let update: any;
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  vendorBand.findFirst = async () => row({ state: 'lost', lostAt: now });
  const band = await markBandLost('seller-1', 'band-1', now);
  assert.equal(band.state, 'lost');
  assert.deepEqual(update.where, { id: 'band-1', sellerId: 'seller-1', state: { not: 'lost' } });
  assert.deepEqual(update.data, { state: 'lost', lostAt: now });

  vendorBand.updateMany = async () => ({ count: 0 });
  vendorBand.findFirst = async () => null;
  await assert.rejects(() => markBandLost('seller-2', 'band-1', now), (err: any) => err instanceof BandRefused && err.status === 404);
});

test('a door refuses a band that is not active, or is not this business\'s', async () => {
  vendorBand.findFirst = async () => row();
  await assert.rejects(() => readBand('seller-1', 'BYT424-0301', now), (err: any) => err instanceof BandRefused && /not activated yet/.test(err.blockers[0]));
  vendorBand.findFirst = async () => row({ state: 'lost', lostAt: now });
  await assert.rejects(() => readBand('seller-1', 'https://bytspot.app/BYT424-0301', now), (err: any) => /marked lost/.test(err.blockers[0]));
  vendorBand.findFirst = async () => null;
  await assert.rejects(() => readBand('seller-2', 'BYT424-0301', now), (err: any) => err instanceof BandRefused && err.status === 404);
  await assert.rejects(() => readBand('seller-1', 'table 4', now), (err: any) => /not a Bytspot band/.test(err.blockers[0]));
});

test('an active band nobody wears yet reads with no ticket', async () => {
  vendorBand.findFirst = async () => row({ state: 'active', tier: 'platinum', locationId: 'loc-1' });
  const read = await readBand('seller-1', 'BYT424-0301', now);
  assert.equal(read.band.holder, null);
  assert.equal(read.band.tier, 'platinum');
  assert.equal(read.booking, undefined);
});

test('a band links once, to the guest whose paid ticket was scanned', async () => {
  let update: any;
  vendorBand.findFirst = async () => row({ state: 'active', locationId: 'loc-1' });
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  vendorBand.findUniqueOrThrow = async () => row({ state: 'active', locationId: 'loc-1', holderUserId: 'guest-1', holder: { name: 'Ama Mensah' }, linkedAt: now });
  const band = await linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now });
  assert.equal(band.holder, 'Ama');
  assert.deepEqual(update.where, { id: 'band-1', sellerId: 'seller-1', state: 'active', holderUserId: null });
  assert.deepEqual(update.data, { holderUserId: 'guest-1', linkedAt: now, linkedBySeatId: 'seat-1' });

  update = undefined;
  vendorBand.findFirst = async () => row({ state: 'active', locationId: 'loc-1', holderUserId: 'guest-1', holder: { name: 'Ama' } });
  assert.equal((await linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now })).holder, 'Ama');
  assert.equal(update, undefined, 'linking the same guest again changes nothing');

  vendorBand.findFirst = async () => row({ state: 'active', locationId: 'loc-1', holderUserId: 'guest-2', holder: { name: 'Kofi' } });
  await assert.rejects(
    () => linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now }),
    (err: any) => /linked to another guest/.test(err.blockers[0]),
  );
});

test('a band does not link to an unpaid ticket or one for another place', async () => {
  vendorBand.findFirst = async () => row({ state: 'active', locationId: 'loc-2', location: { label: 'Uptown' } });
  await assert.rejects(
    () => linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now }),
    (err: any) => err.blockers[0] === 'BYT424-0301 is for Uptown. Use a band for this place',
  );
  vendorTicketOrder.findFirst = async () => null;
  await assert.rejects(
    () => linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'offer-1', now }),
    (err: any) => err instanceof BandRefused && err.status === 404,
  );
});
