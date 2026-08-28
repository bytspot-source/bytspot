import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../lib/db';
import { PAYOUT_DELAY_DAYS, payoutReadiness, READINESS_FRESH_WINDOW_MS, saleablePayoutAccount } from './hostPayouts';

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

test('A stale ready mirror is re-verified before it can decide a sale', async () => {
  const user = (db.user as any);
  const original = user.findUnique;

  // Mirror says ready, but Stripe last spoke long ago. Stripe is unreachable
  // here, so the sale gate must fail closed rather than trust the mirror.
  user.findUnique = async () => ({
    stripeAccountId: 'acct_1', stripeChargesEnabled: true, stripePayoutsEnabled: true,
    stripeAccountRefreshedAt: new Date(Date.now() - READINESS_FRESH_WINDOW_MS - 1_000),
  });
  assert.deepEqual(await saleablePayoutAccount('user-1'), { ok: false, reason: 'unverifiable' });

  // The same mirror, confirmed by Stripe moments ago, is allowed to stand.
  user.findUnique = async () => ({
    stripeAccountId: 'acct_1', stripeChargesEnabled: true, stripePayoutsEnabled: true, stripeAccountRefreshedAt: new Date(),
  });
  assert.deepEqual(await saleablePayoutAccount('user-1'), { ok: true, accountId: 'acct_1' });

  // A host who never started onboarding is refused without asking Stripe.
  user.findUnique = async () => ({ stripeAccountId: null, stripeChargesEnabled: false, stripePayoutsEnabled: false, stripeAccountRefreshedAt: null });
  assert.deepEqual(await saleablePayoutAccount('user-1'), { ok: false, reason: 'no-account' });

  user.findUnique = original;
});
