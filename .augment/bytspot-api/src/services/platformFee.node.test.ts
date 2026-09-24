import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampFeeBps, effectiveFeeBps, MAX_FEE_BPS, splitTicketAmount } from './platformFee';

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
