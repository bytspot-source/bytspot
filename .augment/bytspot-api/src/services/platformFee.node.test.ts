import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampFeeBps, effectiveFeeBps, MAX_FEE_BPS, splitTicketAmount, splitTicketWithProcessing } from './platformFee';

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

test('The application fee covers Stripe so 1.5% is what the platform actually keeps', () => {
  // A $25 ticket at 150 bps: Stripe bills the platform 2.9% + 30c for a
  // destination charge, so collecting only the 37c platform fee would lose 66c
  // on the sale.
  const split = splitTicketWithProcessing(2500, 150);
  assert.equal(split.platformFeeCents, 37);
  assert.equal(split.processingCents, 103);
  assert.equal(split.applicationFeeCents, 140);
  assert.equal(split.hostNetCents, 2360);
  // What Bytspot is left with after Stripe takes its cut of the application fee.
  assert.equal(split.applicationFeeCents - split.processingCents, split.platformFeeCents);
});

test('A ticket too small to cover processing never transfers more than the charge', () => {
  const split = splitTicketWithProcessing(20, 150);
  assert.equal(split.applicationFeeCents, 20);
  assert.equal(split.hostNetCents, 0);
  assert.ok(split.applicationFeeCents + split.hostNetCents === 20);
});
