import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../lib/db';
import { config } from '../config';
import { refundPartyCheckout } from './partyRefunds';

const partyCheckout = db.partyCheckout as any;

test('A refund is only attempted once, and never without a charge to reverse', async () => {
  (config as any).stripeSecretKey = 'test-only-key';

  // Already returned: a redelivered webhook must not issue a second refund.
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: 'pi_1', destinationAccountId: 'acct_1', refundedAt: new Date(), status: 'refund-required' });
  assert.equal(await refundPartyCheckout('checkout-1'), 'already-refunded');

  // Nothing was ever charged, so there is nothing to give back.
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: null, destinationAccountId: null, refundedAt: null, status: 'refund-required' });
  assert.equal(await refundPartyCheckout('checkout-1'), 'nothing-to-refund');

  partyCheckout.findUnique = async () => null;
  assert.equal(await refundPartyCheckout('missing'), 'nothing-to-refund');

  // Stripe unreachable: the guest is still owed money, so this must report
  // failure rather than quietly marking the refund done.
  (config as any).stripeSecretKey = '';
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: 'pi_1', destinationAccountId: 'acct_1', refundedAt: null, status: 'refund-required' });
  assert.equal(await refundPartyCheckout('checkout-1'), 'failed');
});
