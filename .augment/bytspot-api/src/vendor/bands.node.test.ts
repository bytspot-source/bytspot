import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { beforeEach, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { db } from '../lib/db';
import {
  BandRangeRefused,
  BandRefused,
  activateBand,
  activateBandInput,
  assignBands,
  bandRange,
  bandRuns,
  editBand,
  linkBand,
  logVisit,
  markBandLost,
  parseBandSerial,
  readBand,
  releaseBands,
  secureBand,
} from './bands';
import { authAnswer, authFinish, changeKey, enableSdm, fullCommand, ndefTemplate, readNdefUrl, responseVerified } from './ntag424';
import { aesCmac, itemKeys, parseSunCode, verifySun } from './sun';

const vendorBand = db.vendorBand as any;
const vendorLocation = db.vendorLocation as any;
const vendorTicketOrder = db.vendorTicketOrder as any;
const offer = db.offer as any;
const vendorBandVisit = db.vendorBandVisit as any;

const now = new Date('2026-10-18T20:00:00Z');
const showEnds = new Date('2026-10-19T02:00:00Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'band-1', serial: 'BYT424-0301', sellerId: 'seller-1', locationId: null, tier: null, vendorCode: null,
    form: 'band', state: 'assigned', activatedAt: null, lostAt: null, location: null,
    holderUserId: null, holder: null, linkedAt: null, linkedUntil: null, ...over,
  };
}

function codeTaken() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
}

const MASTER = '00112233445566778899aabbccddeeff';
const CHIP = '04A1B2C3D4E5F6';

/** The link a chip set up with the item's keys gives on tap number `counter`. */
function tapLink(counter: number, { serial = 'BYT424-0301', uid = CHIP, master = MASTER } = {}): string {
  const keys = itemKeys(Buffer.from(master, 'hex'), serial);
  const ctr = Buffer.alloc(3);
  ctr.writeUIntLE(counter, 0, 3);
  const picc = Buffer.concat([Buffer.from([0xc7]), Buffer.from(uid, 'hex'), ctr, Buffer.from('a1b2c3d4e5', 'hex')]);
  const cipher = createCipheriv('aes-128-cbc', keys.metaKey, Buffer.alloc(16)).setAutoPadding(false);
  const piccData = Buffer.concat([cipher.update(picc), cipher.final()]).toString('hex').toUpperCase();
  const session = aesCmac(keys.fileKey, Buffer.concat([Buffer.from('3cc300010080', 'hex'), Buffer.from(uid, 'hex'), ctr]));
  const full = aesCmac(session, Buffer.alloc(0));
  const cmac = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i])).toString('hex').toUpperCase();
  return `https://bytspot.app/${serial}?picc_data=${piccData}&cmac=${cmac}`;
}

beforeEach(() => {
  (config as { bandSunMasterKey: string }).bandSunMasterKey = MASTER;
  vendorBand.findMany = async () => [];
  vendorBand.findFirst = async () => row();
  vendorBand.findUniqueOrThrow = async () => row({ state: 'active' });
  vendorBand.updateMany = async () => ({ count: 1 });
  vendorBand.createMany = async (input: any) => ({ count: input.data.length });
  vendorBand.count = async () => 0;
  vendorBand.deleteMany = async () => ({ count: 0 });
  vendorLocation.findFirst = async () => ({ id: 'loc-1' });
  vendorTicketOrder.findFirst = async () => ({ userId: 'guest-1', ticket: { locationId: 'loc-1', endsAt: showEnds } });
  vendorTicketOrder.findMany = async () => [];
  offer.findFirst = async () => null;
  offer.findMany = async () => [];
  vendorBandVisit.count = async () => 0;
  vendorBandVisit.findFirst = async () => null;
  vendorBandVisit.create = async () => ({});
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
    state: 'active', form: 'band', locationId: 'loc-1', tier: 'green', vendorCode: 'VIP-017', activatedAt: now, activatedBySeatId: 'seat-1',
  });
});

test('a band needs a tier; a card, a fob or a table tag does not', async () => {
  assert.equal(activateBandInput.safeParse({ band: 'BYT424-0301', locationId: 'loc-1' }).success, false);
  assert.equal(activateBandInput.safeParse({ band: 'BYT424-0301', locationId: 'loc-1', form: 'band' }).success, false);
  const card = activateBandInput.safeParse({ band: 'BYT424-0301', locationId: 'loc-1', form: 'card' });
  assert.equal(card.success && card.data.form, 'card');
  assert.equal(activateBandInput.safeParse({ band: 'BYT424-0301', locationId: 'loc-1', form: 'wristwatch' }).success, false);

  let update: any;
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  await activateBand('seller-1', 'seat-1', { band: 'BYT424-0301', locationId: 'loc-1', form: 'epoxy', vendorCode: 'Table 4' }, now);
  assert.equal(update.data.form, 'epoxy');
  assert.equal('tier' in update.data, false);
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

test('an item linked to a guest keeps its type until the link ends', async () => {
  vendorBand.findFirst = async () => row({ state: 'active', form: 'card', holderUserId: 'guest-1', linkedUntil: showEnds });
  await assert.rejects(() => editBand('seller-1', 'band-1', { form: 'key_fob' }, now), /stays a card/);
  let data: any;
  vendorBand.updateMany = async (input: any) => { data = input.data; return { count: 1 }; };
  await editBand('seller-1', 'band-1', { form: 'key_fob' }, new Date('2026-10-19T03:00:00Z'));
  assert.deepEqual(data, { form: 'key_fob' });
  vendorBand.findFirst = async () => row({ state: 'active', form: 'card' });
  await assert.rejects(() => editBand('seller-1', 'band-1', { form: 'band' }, now), /Choose a tier/);
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

test('an active band nobody wears yet reads with nothing to check in', async () => {
  vendorBand.findFirst = async () => row({ state: 'active', tier: 'platinum', locationId: 'loc-1' });
  const read = await readBand('seller-1', 'BYT424-0301', now);
  assert.equal(read.band.holder, null);
  assert.equal(read.band.tier, 'platinum');
  assert.equal(read.band.form, 'band');
  assert.deepEqual(read.bookings, []);
});

test('a card past its stay reads as free, and its guest is not shown', async () => {
  let looked = false;
  offer.findMany = async () => { looked = true; return []; };
  vendorBand.findFirst = async () =>
    row({ state: 'active', form: 'card', locationId: 'loc-1', holderUserId: 'guest-1', holder: { name: 'Ama' }, linkedAt: now, linkedUntil: now });
  const read = await readBand('seller-1', 'BYT424-0301', now);
  assert.equal(read.band.holder, null);
  assert.equal(read.band.linkedUntil, null);
  assert.equal(looked, false);
});

test('a tap looks for the guest\'s bookings on the item\'s place, within the seat\'s windows', async () => {
  let where: any;
  offer.findMany = async (input: any) => { where = input.where; return []; };
  let ticketsLooked = false;
  vendorTicketOrder.findMany = async () => { ticketsLooked = true; return []; };
  vendorBand.findFirst = async () => row({ state: 'active', form: 'card', locationId: 'loc-1', holderUserId: 'guest-1', linkedUntil: showEnds });
  await readBand('seller-1', 'BYT424-0301', now, ['win-1']);
  assert.equal(where.sellerId, 'seller-1');
  assert.equal(where.state, 'ACCEPTED');
  assert.deepEqual(where.demand, { raisedByUserId: 'guest-1' });
  assert.equal(where.locationId, 'loc-1');
  assert.deepEqual(where.windowId, { in: ['win-1'] });
  assert.equal(ticketsLooked, false, 'tickets hang off no window, so a scoped seat sees none');
});

test('a key fob reads the member\'s visits; a table tag never reads a guest', async () => {
  vendorBandVisit.count = async () => 7;
  vendorBandVisit.findFirst = async () => ({ createdAt: now });
  vendorBand.findFirst = async () => row({ state: 'active', form: 'key_fob', holderUserId: 'guest-1', holder: { name: 'Kofi' } });
  const fob = await readBand('seller-1', 'BYT424-0301', now);
  assert.deepEqual(fob.member, { visits: 7, lastVisitAt: now.toISOString() });

  vendorBand.findFirst = async () => row({ state: 'active', form: 'epoxy', vendorCode: 'Table 4', holderUserId: 'guest-1' });
  const tag = await readBand('seller-1', 'BYT424-0301', now);
  assert.deepEqual(tag.bookings, []);
  assert.equal(tag.member, undefined);
});

test('a band links once, to the guest whose paid ticket was scanned', async () => {
  let update: any;
  vendorBand.findFirst = async () => row({ state: 'active', locationId: 'loc-1' });
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  vendorBand.findUniqueOrThrow = async () => row({ state: 'active', locationId: 'loc-1', holderUserId: 'guest-1', holder: { name: 'Ama Mensah' }, linkedAt: now });
  const band = await linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now });
  assert.equal(band.holder, 'Ama');
  assert.deepEqual(update.where, {
    id: 'band-1', sellerId: 'seller-1', state: 'active', OR: [{ holderUserId: null }, { linkedUntil: { lte: now } }],
  });
  assert.deepEqual(update.data, { holderUserId: 'guest-1', linkedAt: now, linkedBySeatId: 'seat-1', linkedUntil: null });

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
    (err: any) => err.blockers[0] === 'BYT424-0301 is for Uptown. Use one for this place',
  );
  vendorTicketOrder.findFirst = async () => null;
  await assert.rejects(
    () => linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'offer-1', now }),
    (err: any) => err instanceof BandRefused && err.status === 404,
  );
});

test('a card links from a stay booking and stays linked until the stay ends', async () => {
  const checkout = new Date('2026-10-21T11:00:00Z');
  offer.findFirst = async () => ({ locationId: 'loc-1', startsAt: now, durationMins: (checkout.getTime() - now.getTime()) / 60_000, demand: { raisedByUserId: 'guest-3' } });
  let update: any;
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  vendorBand.findFirst = async () => row({ state: 'active', form: 'card', locationId: 'loc-1' });
  vendorBand.findUniqueOrThrow = async () => row({ state: 'active', form: 'card', holderUserId: 'guest-3', holder: { name: 'Efua' }, linkedUntil: checkout });
  const card = await linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'offer-1', now });
  assert.equal(update.data.holderUserId, 'guest-3');
  assert.equal(update.data.linkedUntil.getTime(), checkout.getTime());
  assert.equal(card.linkedUntil, checkout.toISOString());
});

test('a card whose last stay ended links to the next guest', async () => {
  let update: any;
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  vendorBand.findFirst = async () => row({ state: 'active', form: 'event_fob', locationId: 'loc-1', holderUserId: 'guest-9', linkedUntil: new Date('2026-10-11T02:00:00Z') });
  vendorBand.findUniqueOrThrow = async () => row({ state: 'active', form: 'event_fob', holderUserId: 'guest-1', linkedUntil: showEnds });
  await linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now });
  assert.equal(update.data.holderUserId, 'guest-1');
  assert.equal(update.data.linkedUntil, showEnds);
});

test('a table tag does not link, and an ended booking links nothing', async () => {
  vendorBand.findFirst = async () => row({ state: 'active', form: 'epoxy', locationId: 'loc-1' });
  await assert.rejects(
    () => linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now }),
    /is a table tag/,
  );
  vendorBand.findFirst = async () => row({ state: 'active', form: 'key_fob', locationId: 'loc-1' });
  vendorTicketOrder.findFirst = async () => ({ userId: 'guest-1', ticket: { locationId: 'loc-1', endsAt: now } });
  await assert.rejects(() => linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now }), /has ended/);
});

test('a key fob visit is logged once per visit, and only for a linked key fob', async () => {
  let created: any;
  vendorBandVisit.create = async (input: any) => { created = input.data; return {}; };
  vendorBandVisit.count = async () => 1;
  vendorBand.findFirst = async () => row({ state: 'active', form: 'key_fob', holderUserId: 'guest-1' });
  const first = await logVisit({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', now });
  assert.equal(first.alreadyLogged, false);
  assert.deepEqual(created, { sellerId: 'seller-1', bandId: 'band-1', userId: 'guest-1', seatId: 'seat-1', createdAt: now });

  created = undefined;
  vendorBandVisit.findFirst = async () => ({ id: 'visit-1', createdAt: now });
  assert.equal((await logVisit({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', now })).alreadyLogged, true);
  assert.equal(created, undefined);

  vendorBand.findFirst = async () => row({ state: 'active', form: 'band', holderUserId: 'guest-1' });
  await assert.rejects(() => logVisit({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', now }), /key fob members/);
  vendorBand.findFirst = async () => row({ state: 'active', form: 'key_fob' });
  await assert.rejects(() => logVisit({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', now }), /not linked to a member/);
});

test('AES-CMAC matches RFC 4493, and NXP\'s sample tap reads its UID and counter', () => {
  const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  assert.equal(aesCmac(key, Buffer.alloc(0)).toString('hex'), 'bb1d6929e95937287fa37d129b756746');
  assert.equal(aesCmac(key, Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex')).toString('hex'), '070a16b46b4d4144f79bdd9dd04a287c');
  assert.equal(
    aesCmac(key, Buffer.from('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411', 'hex')).toString('hex'),
    'dfa66747de9ae63030ca32611497c827',
  );
  const factory = { metaKey: Buffer.alloc(16), fileKey: Buffer.alloc(16) };
  const sample = parseSunCode('https://sdm.nfcdeveloper.com/tag?picc_data=EF963FF7828658A599F3041510671E88&cmac=94EED9EE65337086');
  assert.deepEqual(verifySun(factory, sample!), { uid: '04DE5F1EACC040', counter: 61 });
  assert.equal(verifySun(factory, { ...sample!, cmac: '94EED9EE65337087' }), undefined);
  assert.equal(verifySun(factory, { ...sample!, piccData: 'nope' }), undefined);
  assert.equal(parseSunCode('https://bytspot.app/BYT424-0301'), undefined);
  assert.equal(parseBandSerial(tapLink(1)), 'BYT424-0301');
});

test('the first tap with a valid fresh code secures the item and binds its chip', async () => {
  let update: any;
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  vendorBand.findFirst = async () => row({ state: 'active', form: 'event_fob', locationId: 'loc-1' });
  const read = await readBand('seller-1', tapLink(7), now);
  assert.equal(read.band.secured, true);
  assert.deepEqual(update.where, { id: 'band-1', state: 'active', sunUid: null, sunCounter: null });
  assert.deepEqual(update.data, { sunUid: CHIP, sunCounter: 7, lastTapAt: now, securedAt: now });

  update = undefined;
  vendorBand.findFirst = async () => row({ state: 'active', locationId: 'loc-1' });
  assert.equal((await readBand('seller-1', 'BYT424-0301', now)).band.secured, false);
  assert.equal(update, undefined, 'an item that is not secured reads by its number as before');
});

test('a secured item needs a new code on every tap', async () => {
  const secured = { state: 'active', form: 'band', locationId: 'loc-1', sunUid: CHIP, sunCounter: 7, securedAt: now, lastTapAt: now };
  let update: any;
  vendorBand.updateMany = async (input: any) => { update = input; return { count: 1 }; };
  vendorBand.findFirst = async () => row(secured);

  await readBand('seller-1', tapLink(8), now);
  assert.deepEqual(update.where, { id: 'band-1', state: 'active', sunUid: CHIP, sunCounter: { lt: 8 } });
  assert.deepEqual(update.data, { sunUid: CHIP, sunCounter: 8, lastTapAt: now });

  for (const [raw, reason] of [
    ['BYT424-0301', /printed number is not enough/],
    ['https://bytspot.app/BYT424-0301', /printed number is not enough/],
    [tapLink(7), /already used/],
    [tapLink(3), /already used/],
    [tapLink(9, { uid: '04FFFFFFFFFFFF' }), /may be a copy/],
    [tapLink(9, { master: 'ffeeddccbbaa99887766554433221100' }), /may be a copy/],
    [tapLink(9, { serial: 'BYT424-0302' }).replace('0302', '0301'), /may be a copy/],
    [`${tapLink(9).slice(0, -1)}0`, /may be a copy/],
  ] as const) {
    await assert.rejects(() => readBand('seller-1', raw, now), (err: any) => err instanceof BandRefused && reason.test(err.blockers[0]), raw);
  }
  await assert.rejects(
    () => linkBand({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', bookingId: 'order-1', now }),
    /printed number is not enough/,
  );

  vendorBand.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => readBand('seller-1', tapLink(9), now), /already used/, 'two phones with the same tap: one wins');
});

test('a secured key fob logs the visit just read, but not one read long ago', async () => {
  vendorBand.findFirst = async () =>
    row({ state: 'active', form: 'key_fob', holderUserId: 'guest-1', sunUid: CHIP, sunCounter: 4, securedAt: now, lastTapAt: new Date(now.getTime() - 60_000) });
  assert.equal((await logVisit({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', now })).alreadyLogged, false);
  vendorBand.findFirst = async () =>
    row({ state: 'active', form: 'key_fob', holderUserId: 'guest-1', sunUid: CHIP, sunCounter: 4, securedAt: now, lastTapAt: new Date(now.getTime() - 6 * 60_000) });
  await assert.rejects(() => logVisit({ sellerId: 'seller-1', seatId: 'seat-1', band: 'BYT424-0301', now }), /printed number is not enough/);
  await assert.rejects(() => readBand('seller-1', 'BYT424-0301', now), /printed number is not enough/, 'a read is never held');
});

test('without the master key a secured item is refused, and an unsecured one reads as before', async () => {
  (config as { bandSunMasterKey: string }).bandSunMasterKey = '';
  let updated = false;
  vendorBand.updateMany = async () => { updated = true; return { count: 1 }; };
  vendorBand.findFirst = async () => row({ state: 'active', sunUid: CHIP, sunCounter: 7, securedAt: now });
  await assert.rejects(() => readBand('seller-1', tapLink(8), now), /cannot be checked right now/);
  vendorBand.findFirst = async () => row({ state: 'active' });
  assert.equal((await readBand('seller-1', tapLink(8), now)).band.secured, false);
  assert.equal(updated, false);
});

test('the chip commands match NXP\'s worked examples (AN12196)', () => {
  const hex = (value: string) => Buffer.from(value, 'hex');
  const upper = (value: Buffer) => value.toString('hex').toUpperCase();
  const reply = authAnswer(Buffer.alloc(16), hex('A04C124213C186F22399D33AC2A3021591AF'), hex('13C5DB8A5930439FC3DEF9A4C675360F'))!;
  assert.equal(upper(reply.apdu), '90AF00002035C3E05A752E0144BAC0DE51C1F22C56B34408A23D8AEA266CAB947EA8E0118D00');
  const session = authFinish(Buffer.alloc(16), reply.rndA, reply.rndB, hex('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F081206639100'))!;
  assert.equal(upper(session.ti), '9D00C4DF');
  assert.equal(upper(session.encKey), '1309C877509E5A215007FF0ED19CA564');
  assert.equal(upper(session.macKey), '4C6626F5E72EA694202139295C7A7FC7');
  assert.equal(authFinish(Buffer.alloc(16), reply.rndA, reply.rndB, hex('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F081206639100').fill(0, 0, 1)), undefined);

  session.counter = 1;
  assert.equal(upper(fullCommand(session, 0x5f, hex('02'), hex('4000E0C1F121200000430000430000'))), '905F0000190261B6D97903566E84C3AE5274467E89EAD799B7C1A0EF7A0400');
  assert.equal(responseVerified(session, 1, hex('57BFF87B1241E93D9100')), true);
  assert.equal(responseVerified(session, 2, hex('57BFF87B1241E93D9100')), false);

  const keys = { encKey: hex('4CF3CB41A22583A61E89B158D252FC53'), macKey: hex('5529860B2FC5FB6154B7F28361D30BF9'), ti: hex('7614281A'), counter: 2 };
  assert.equal(
    upper(changeKey(keys, 2, hex('F3847D627727ED3BC9C4CC050489B966'), Buffer.alloc(16))),
    '90C4000029022CF362B7BF4311FF3BE1DAA295E8C68DE09050560D19B9E16C2393AE9CD1FAC75D0CE20BCD1D06E600',
  );
  assert.equal(
    upper(changeKey(keys, 0, hex('5004BF991F408672B1EF00F08F9E8647'), Buffer.alloc(16))),
    '90C400002900C0EB4DEEFEDDF0B513A03A95A75491818580503190D4D05053FF75668A01D6FDA6610234BDED643200',
  );

  const template = ndefTemplate('BYT424-0301');
  assert.equal(template.file.subarray(template.piccOffset, template.piccOffset + 32).toString('ascii'), '0'.repeat(32));
  assert.equal(template.file.subarray(template.macOffset - 6, template.macOffset).toString('ascii'), '&cmac=');
  assert.equal(readNdefUrl(Buffer.concat([template.file, hex('9000')])), `https://bytspot.app/BYT424-0301?picc_data=${'0'.repeat(32)}&cmac=${'0'.repeat(16)}`);
  assert.equal(upper(enableSdm({ ...keys, counter: 0 }, template)).slice(0, 10), '905F000019');
});

/** An NTAG 424 DNA chip, to the extent securing it uses, with its own crypto. */
class Chip {
  keys: Buffer[] = [0, 1, 2, 3, 4].map(() => Buffer.alloc(16));
  ndef: Buffer = Buffer.concat([Buffer.from('0021d1011d5504', 'hex'), Buffer.from('bytspot.app/BYT424-0301', 'ascii')]);
  writeFree = true;
  sdm?: { picc: number; mac: number };
  readCtr = 0;
  private pending?: { rndB: Buffer; keyNo: number };
  private session?: { enc: Buffer; mac: Buffer; ti: Buffer; ctr: number; keyNo: number };

  constructor(readonly uid = CHIP) {}

  private aes(decrypt: boolean, key: Buffer, iv: Buffer | null, data: Buffer) {
    const mode = iv ? 'aes-128-cbc' : 'aes-128-ecb';
    const c = (decrypt ? createDecipheriv(mode, key, iv) : createCipheriv(mode, key, iv)).setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  }

  private mact(key: Buffer, data: Buffer) {
    const full = aesCmac(key, data);
    return Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]));
  }

  private sw(code: string, data: Buffer = Buffer.alloc(0)) {
    if (!code.startsWith('91') || code === '9100' || code === '91AF') return Buffer.concat([data, Buffer.from(code, 'hex')]);
    this.session = undefined;
    return Buffer.from(code, 'hex');
  }

  private ok(data: Buffer = Buffer.alloc(0)) {
    const s = this.session!;
    s.ctr += 1;
    const ctr = Buffer.alloc(2);
    ctr.writeUInt16LE(s.ctr);
    return Buffer.concat([data, this.mact(s.mac, Buffer.concat([Buffer.from([0]), ctr, s.ti, data])), Buffer.from('9100', 'hex')]);
  }

  transmit(apdu: Buffer): Buffer {
    const head = apdu.subarray(0, 2).toString('hex').toUpperCase();
    if (head === '00A4') return this.sw('9000');
    if (head === '00B0') {
      const file = Buffer.alloc(256);
      this.ndef.copy(file);
      if (this.sdm) {
        this.readCtr += 1;
        const ctr = Buffer.alloc(3);
        ctr.writeUIntLE(this.readCtr, 0, 3);
        const uid = Buffer.from(this.uid, 'hex');
        const picc = this.aes(false, this.keys[2], Buffer.alloc(16), Buffer.concat([Buffer.from([0xc7]), uid, ctr, randomBytes(5)]));
        const session = aesCmac(this.keys[1], Buffer.concat([Buffer.from('3cc300010080', 'hex'), uid, ctr]));
        Buffer.from(picc.toString('hex').toUpperCase(), 'ascii').copy(file, this.sdm.picc);
        Buffer.from(this.mact(session, Buffer.alloc(0)).toString('hex').toUpperCase(), 'ascii').copy(file, this.sdm.mac);
      }
      return this.sw('9000', file);
    }
    if (head === '00D6') {
      if (!this.writeFree) return this.sw('6982');
      this.ndef = Buffer.from(apdu.subarray(5, 5 + apdu[4]));
      return this.sw('9000');
    }
    if (head === '9071') {
      const keyNo = apdu[5];
      this.session = undefined;
      this.pending = { rndB: randomBytes(16), keyNo };
      return this.sw('91AF', this.aes(false, this.keys[keyNo], Buffer.alloc(16), this.pending.rndB));
    }
    if (head === '90AF' && this.pending) {
      const { rndB, keyNo } = this.pending;
      this.pending = undefined;
      const key = this.keys[keyNo];
      const plain = this.aes(true, key, Buffer.alloc(16), apdu.subarray(5, 37));
      const rndA = plain.subarray(0, 16);
      if (!plain.subarray(16).equals(Buffer.concat([rndB.subarray(1), rndB.subarray(0, 1)]))) return this.sw('91AE');
      const ti = randomBytes(4);
      const x = Buffer.from(rndA.subarray(2, 8).map((b, i) => b ^ rndB[i]));
      const ctx = Buffer.concat([rndA.subarray(0, 2), x, rndB.subarray(6), rndA.subarray(8)]);
      this.session = {
        enc: aesCmac(key, Buffer.concat([Buffer.from('a55a00010080', 'hex'), ctx])),
        mac: aesCmac(key, Buffer.concat([Buffer.from('5aa500010080', 'hex'), ctx])),
        ti,
        ctr: 0,
        keyNo,
      };
      const body = Buffer.concat([ti, rndA.subarray(1), rndA.subarray(0, 1), Buffer.alloc(12)]);
      return this.sw('9100', this.aes(false, key, Buffer.alloc(16), body));
    }
    const s = this.session;
    if ((head === '905F' || head === '90C4') && s) {
      const ins = apdu[1];
      const body = apdu.subarray(5, 5 + apdu[4]);
      const header = body.subarray(0, 1);
      const encrypted = body.subarray(1, -8);
      const ctr = Buffer.alloc(2);
      ctr.writeUInt16LE(s.ctr);
      if (!this.mact(s.mac, Buffer.concat([Buffer.from([ins]), ctr, s.ti, header, encrypted])).equals(body.subarray(-8))) return this.sw('911E');
      const iv = this.aes(false, s.enc, null, Buffer.concat([Buffer.from('a55a', 'hex'), s.ti, ctr, Buffer.alloc(8)]));
      const data = this.aes(true, s.enc, iv, encrypted);
      if (ins === 0x5f) {
        if (s.keyNo !== 0) return this.sw('919D');
        this.writeFree = (data[2] & 0x0f) === 0x0e;
        this.sdm = data[0] & 0x40 ? { picc: data.readUIntLE(6, 3), mac: data.readUIntLE(12, 3) } : undefined;
        return this.ok();
      }
      const keyNo = header[0];
      if (keyNo === s.keyNo) {
        this.keys[keyNo] = Buffer.from(data.subarray(0, 16));
        this.session = undefined;
        return Buffer.from('9100', 'hex');
      }
      const next = Buffer.from(data.subarray(0, 16).map((b, i) => b ^ this.keys[keyNo][i]));
      if (data.readUInt32LE(17) !== (~crc32(next)) >>> 0) return this.sw('911E');
      this.keys[keyNo] = next;
      return this.ok();
    }
    return this.sw('911C');
  }
}

/** Plays the phone: sends each APDU in order and stops at the first the chip refuses. */
async function secureWith(chip: Chip, link = 'https://bytspot.app/BYT424-0301') {
  let state: string | undefined;
  let responses: string[] | undefined;
  for (let round = 0; round < 12; round++) {
    const step = await secureBand('seller-1', { band: link, uid: chip.uid, state, responses }, now);
    if ('band' in step) return step.band;
    responses = [];
    for (const apdu of step.apdus) {
      const reply = chip.transmit(Buffer.from(apdu, 'hex'));
      responses.push(reply.toString('hex'));
      if (!['9000', '9100', '91AF'].includes(reply.subarray(-2).toString('hex').toUpperCase())) break;
    }
    state = step.state;
  }
  throw new Error('securing did not finish');
}

function securingRow() {
  let secured: any;
  vendorBand.findFirst = async () => row({ state: 'active', locationId: 'loc-1', ...secured });
  vendorBand.updateMany = async (input: any) => { secured = { ...secured, ...input.data }; return { count: 1 }; };
  vendorBand.findUniqueOrThrow = async () => row({ state: 'active', locationId: 'loc-1', ...secured });
  return () => secured;
}

test('a factory chip is secured from the phone, and then only its fresh taps open it', async () => {
  const saved = securingRow();
  const chip = new Chip();
  const band = await secureWith(chip);
  assert.equal(band.secured, true);
  assert.equal(saved().sunUid, CHIP);
  assert.equal(saved().sunCounter, 1);
  const keys = itemKeys(Buffer.from(MASTER, 'hex'), 'BYT424-0301');
  assert.deepEqual(chip.keys.slice(0, 3), [keys.appKey, keys.fileKey, keys.metaKey], 'the chip now holds the item\'s keys');
  assert.equal(chip.writeFree, false, 'only key 0 may rewrite the link');

  const tap = () => readNdefUrl(chip.transmit(Buffer.from('00B0000000', 'hex')))!;
  const first = tap();
  assert.match(first, /^https:\/\/bytspot\.app\/BYT424-0301\?picc_data=[0-9A-F]{32}&cmac=[0-9A-F]{16}$/);
  assert.equal((await readBand('seller-1', first, now)).band.secured, true);
  await assert.rejects(() => readBand('seller-1', first, now), /already used/);
  await assert.rejects(() => readBand('seller-1', 'BYT424-0301', now), /printed number is not enough/);
  await readBand('seller-1', tap(), now);
  assert.equal(saved().sunCounter, 3);
});

test('a chip left half done is finished, and a secured item is not set up again', async () => {
  const keys = itemKeys(Buffer.from(MASTER, 'hex'), 'BYT424-0301');
  securingRow();
  const halfway = new Chip();
  halfway.keys[1] = keys.fileKey;
  halfway.keys[2] = keys.metaKey;
  halfway.writeFree = false;
  halfway.ndef = ndefTemplate('BYT424-0301').file;
  halfway.sdm = { picc: ndefTemplate('BYT424-0301').piccOffset, mac: ndefTemplate('BYT424-0301').macOffset };
  assert.equal((await secureWith(halfway)).secured, true);
  assert.deepEqual(halfway.keys[0], keys.appKey, 'key 0 was still the factory one, so it was changed too');

  securingRow();
  const onlyKey1 = new Chip();
  onlyKey1.keys[1] = keys.fileKey;
  assert.equal((await secureWith(onlyKey1)).secured, true);
  assert.deepEqual(onlyKey1.keys.slice(0, 3), [keys.appKey, keys.fileKey, keys.metaKey]);

  securingRow();
  const done = new Chip();
  await secureWith(done);
  const before = done.keys.map((key) => Buffer.from(key));
  securingRow();
  assert.equal((await secureWith(done)).secured, true, 'a chip already Bytspot\'s is secured without writing');
  assert.deepEqual(done.keys, before);

  let asked = false;
  vendorBand.findFirst = async () => { asked = true; return row({ state: 'active', securedAt: now, sunUid: CHIP, sunCounter: 4 }); };
  assert.equal((await secureBand('seller-1', { band: 'BYT424-0301', uid: CHIP }, now) as any).band.secured, true);
  assert.equal(asked, true);
});

test('securing refuses another company\'s keys, another chip, a changed state and a lost band', async () => {
  securingRow();
  const foreign = new Chip();
  foreign.keys[0] = Buffer.alloc(16, 7);
  await assert.rejects(() => secureWith(foreign), /set up with other keys/);

  securingRow();
  const start = await secureBand('seller-1', { band: 'BYT424-0301', uid: CHIP }, now) as any;
  const other = { band: 'BYT424-0301', uid: '04FFFFFFFFFFFF', state: start.state, responses: ['9000', '9000', '9000'] };
  await assert.rejects(() => secureBand('seller-1', other, now), /tap the same item/);
  await assert.rejects(() => secureBand('seller-2', { ...other, uid: CHIP }, now), /tap the same item/);
  await assert.rejects(() => secureBand('seller-1', { ...other, uid: CHIP, state: `${start.state.slice(0, -2)}AA` }, now), /tap the same item/);
  await assert.rejects(
    () => secureBand('seller-1', { ...other, uid: CHIP }, new Date(now.getTime() + 4 * 60_000)),
    /took too long/,
  );
  await assert.rejects(() => secureBand('seller-1', { band: 'BYT424-0301', uid: '04A1B2C3' }, now), /hides its number/);

  const elsewhere = new Chip();
  elsewhere.ndef = Buffer.concat([Buffer.from('0021d1011d5504', 'hex'), Buffer.from('bytspot.app/BYT424-0302', 'ascii')]);
  await assert.rejects(() => secureWith(elsewhere), /another number than BYT424-0301/);

  vendorBand.findFirst = async () => row({ state: 'lost' });
  await assert.rejects(() => secureBand('seller-1', { band: 'BYT424-0301', uid: CHIP }, now), /marked lost/);
  (config as { bandSunMasterKey: string }).bandSunMasterKey = '';
  await assert.rejects(() => secureBand('seller-1', { band: 'BYT424-0301', uid: CHIP }, now), /not set up yet/);
});
