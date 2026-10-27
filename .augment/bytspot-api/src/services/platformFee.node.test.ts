import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../config';
import { db } from '../lib/db';
import { clampFeeBps, currentPlatformFeeBps, defaultFeeBps, effectiveFeeBps, FEE_SCOPES, MAX_FEE_BPS, splitTicketAmount, VENDOR_BOOKING_FEE_SCOPE } from './platformFee';

test('a party keeps the rate it was published with when the market rate moves', () => {
  // Host published at 10%, Bytspot later moved the market rate to 25%.
  assert.equal(effectiveFeeBps(1_000, 2_500), 1_000);
});

test('a party with no snapshot falls back to the current rate', () => {
  assert.equal(effectiveFeeBps(null, 1_500), 1_500);
  assert.equal(effectiveFeeBps(undefined, 0), 0);
});

test('a snapshot of zero is honoured rather than treated as missing', () => {
  // Parties published while the fee was 0 must stay free, so the nullish check
  // has to distinguish 0 from absent.
  assert.equal(effectiveFeeBps(0, 2_000), 0);
});

test('the fee is bounded so a bad value cannot take a whole sale', () => {
  assert.equal(clampFeeBps(-1), 0);
  assert.equal(clampFeeBps(99_999), MAX_FEE_BPS);
  assert.equal(clampFeeBps(Number.NaN), 0);
});

test('the split always reconciles to the gross', () => {
  for (const [amount, bps] of [[5_000, 1_000], [999, 1_250], [1, 5_000], [0, 1_000]] as const) {
    const { feeCents, hostNetCents } = splitTicketAmount(amount, bps);
    assert.equal(feeCents + hostNetCents, amount, `gross ${amount} at ${bps}bps must reconcile`);
    assert.ok(feeCents >= 0 && hostNetCents >= 0);
  }
});

test('rounding never favours the platform over the host', () => {
  // 999c at 12.5% is 124.875c. Rounding up would quietly overcharge the host.
  assert.deepEqual(splitTicketAmount(999, 1_250), { feeCents: 124, hostNetCents: 875 });
});

test('a zero fee leaves the whole ticket with the host', () => {
  assert.deepEqual(splitTicketAmount(5_000, 0), { feeCents: 0, hostNetCents: 5_000 });
});

test('a booking fee is the rate, with a minimum that never takes more than half', async () => {
  const { splitBookingAmount } = await import('./platformFee');
  assert.deepEqual(splitBookingAmount(5_000, 1_000, 100), { feeCents: 500, sellerNetCents: 4_500 });
  // 10% of $8 is 80¢, so the $1 minimum applies.
  assert.deepEqual(splitBookingAmount(800, 1_000, 100), { feeCents: 100, sellerNetCents: 700 });
  // The minimum is capped at half a very small booking.
  assert.deepEqual(splitBookingAmount(150, 1_000, 100), { feeCents: 75, sellerNetCents: 75 });
  // A zero rate means no fee at all, minimum included.
  assert.deepEqual(splitBookingAmount(5_000, 0, 100), { feeCents: 0, sellerNetCents: 5_000 });
});

test('a table from a business the host asked is netted apart from the door, and nothing is lost', async () => {
  const { splitHostAndSellerAmount } = await import('./platformFee');
  // $25 door + $400 table at 10%: the host nets the door, the business the table.
  assert.deepEqual(splitHostAndSellerAmount(2_500, 40_000, 1_000), { feeCents: 4_250, hostNetCents: 2_250, sellerNetCents: 36_000 });
  // A table bought alone owes the host nothing.
  assert.deepEqual(splitHostAndSellerAmount(0, 40_000, 1_000), { feeCents: 4_000, hostNetCents: 0, sellerNetCents: 36_000 });
  for (const [door, table, bps] of [[999, 12_345, 1_250], [1, 1, 3_000], [0, 99, 777]]) {
    const split = splitHostAndSellerAmount(door, table, bps);
    assert.equal(split.feeCents + split.hostNetCents + split.sellerNetCents, door + table);
  }
});

test('each scope falls back to its own default until an admin sets a rate', async () => {
  assert.deepEqual([...FEE_SCOPES], ['party-ticket', 'vendor-booking']);
  assert.equal(defaultFeeBps('party-ticket'), config.defaultPlatformFeeBps);
  assert.equal(defaultFeeBps(VENDOR_BOOKING_FEE_SCOPE), config.vendorBookingFeeBps);
  const original = (db.platformFeeSetting as any).findFirst;
  try {
    (db.platformFeeSetting as any).findFirst = async () => null;
    assert.equal(await currentPlatformFeeBps(VENDOR_BOOKING_FEE_SCOPE, defaultFeeBps(VENDOR_BOOKING_FEE_SCOPE)), config.vendorBookingFeeBps);
    (db.platformFeeSetting as any).findFirst = async ({ where }: any) => (where.scope === VENDOR_BOOKING_FEE_SCOPE ? { feeBps: 1_200 } : null);
    assert.equal(await currentPlatformFeeBps(VENDOR_BOOKING_FEE_SCOPE, defaultFeeBps(VENDOR_BOOKING_FEE_SCOPE)), 1_200);
  } finally {
    (db.platformFeeSetting as any).findFirst = original;
  }
});
