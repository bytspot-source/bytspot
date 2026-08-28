import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAYOUT_DELAY_DAYS, payoutReadiness } from './hostPayouts';

test('A host is payout-ready only with an account and both Stripe flags', () => {
  assert.equal(payoutReadiness(null).ready, false);
  assert.equal(payoutReadiness({ stripeAccountId: null, stripeChargesEnabled: true, stripePayoutsEnabled: true }).ready, false);
  // Charges without payouts is the trap: tickets sell for money the host can
  // never withdraw, so it must not read as ready.
  assert.equal(payoutReadiness({ stripeAccountId: 'acct_1', stripeChargesEnabled: true, stripePayoutsEnabled: false }).ready, false);
  assert.equal(payoutReadiness({ stripeAccountId: 'acct_1', stripeChargesEnabled: false, stripePayoutsEnabled: true }).ready, false);

  const ready = payoutReadiness({ stripeAccountId: 'acct_1', stripeChargesEnabled: true, stripePayoutsEnabled: true });
  assert.deepEqual(ready, { accountId: 'acct_1', chargesEnabled: true, payoutsEnabled: true, ready: true });
});

test('Payouts stay reversible until after a party has happened', () => {
  // Funds land in the connected balance at purchase but only reach a bank a
  // week later, so a refund or cancellation is still recoverable.
  assert.equal(PAYOUT_DELAY_DAYS, 7);
});
