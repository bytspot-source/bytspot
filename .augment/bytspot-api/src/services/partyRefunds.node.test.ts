import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../lib/db';
import { config } from '../config';
import { refundPartyCheckout } from './partyRefunds';

const partyCheckout = db.partyCheckout as any;

test('A refund is only attempted once, and never without a charge to reverse', async () => {
  (config as any).stripeSecretKey = 'test-only-key';

  // Already returned: a redelivered webhook must not issue a second refund.
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: 'pi_1', stripeSessionId: 'cs_1', destinationAccountId: 'acct_1', refundedAt: new Date(), status: 'refund-required' });
  assert.equal(await refundPartyCheckout('checkout-1'), 'already-refunded');

  // Nothing was ever charged, so there is nothing to give back.
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: null, stripeSessionId: null, destinationAccountId: null, refundedAt: null, status: 'refund-required' });
  assert.equal(await refundPartyCheckout('checkout-1'), 'nothing-to-refund');

  partyCheckout.findUnique = async () => null;
  assert.equal(await refundPartyCheckout('missing'), 'nothing-to-refund');

  // Stripe unreachable: the guest is still owed money, so this must report
  // failure rather than quietly marking the refund done.
  (config as any).stripeSecretKey = '';
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: 'pi_1', stripeSessionId: 'cs_1', destinationAccountId: 'acct_1', refundedAt: null, status: 'refund-required' });
  assert.equal(await refundPartyCheckout('checkout-1'), 'failed');

  // A paid checkout whose Session yields no charge is a contradiction: it must
  // stay refund-required rather than be dismissed as unrefundable.
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: null, stripeSessionId: 'cs_1', destinationAccountId: null, refundedAt: null, status: 'refund-required' });
  assert.equal(await refundPartyCheckout('checkout-1'), 'failed');
});


test('A sale made before the payout rail is refunded off its Session, with nothing to reverse', async () => {
  (config as any).stripeSecretKey = 'test-only-key';
  let refundArgs: any;
  let refundOptions: any;
  let persisted: any;
  const stripe: any = {
    checkout: { sessions: { retrieve: async (id: string) => ({ id, payment_intent: 'pi_recovered' }) } },
    refunds: { create: async (args: any, options: any) => { refundArgs = args; refundOptions = options; return { id: 're_1' }; } },
  };
  // No destination: the whole charge is still Bytspot's, so there is no host
  // transfer to claw back and no application fee to give up.
  partyCheckout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: null, stripeSessionId: 'cs_legacy', destinationAccountId: null, refundedAt: null, status: 'refund-required' });
  partyCheckout.update = async (input: any) => { persisted = input; return { id: 'checkout-1' }; };

  assert.equal(await refundPartyCheckout('checkout-1', stripe), 'refunded');
  assert.deepEqual(refundArgs, { payment_intent: 'pi_recovered', reverse_transfer: false, refund_application_fee: false });
  // Keyed per checkout so a redelivered webhook cannot refund twice.
  assert.equal(refundOptions.idempotencyKey, 'party-refund:checkout-1');
  assert.equal(persisted.data.stripePaymentIntentId, 'pi_recovered');
  assert.ok(persisted.data.refundedAt instanceof Date);
});

test('A destination-charge refund claws back the host transfer and gives up the fee', async () => {
  (config as any).stripeSecretKey = 'test-only-key';
  let refundArgs: any;
  const stripe: any = {
    checkout: { sessions: { retrieve: async () => { throw new Error('should not be needed'); } } },
    refunds: { create: async (args: any) => { refundArgs = args; return { id: 're_2' }; } },
  };
  partyCheckout.findUnique = async () => ({ id: 'checkout-2', stripePaymentIntentId: 'pi_2', stripeSessionId: 'cs_2', destinationAccountId: 'acct_1', refundedAt: null, status: 'refund-required' });
  partyCheckout.update = async () => ({ id: 'checkout-2' });

  assert.equal(await refundPartyCheckout('checkout-2', stripe), 'refunded');
  // Bytspot keeps no fee on a refunded sale.
  assert.deepEqual(refundArgs, { payment_intent: 'pi_2', reverse_transfer: true, refund_application_fee: true });
});

test('An unconfigured refund is recorded as a failed attempt, not a silent skip', async () => {
  const checkout = db.partyCheckout as any;
  let update: any;
  checkout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: 'pi_1', stripeSessionId: null, destinationAccountId: null, refundedAt: null, status: 'completed' });
  checkout.update = async (args: any) => { update = args; return {}; };
  (config as any).stripeSecretKey = '';

  // The scheduled purge job used to run without Stripe, so every refund failed
  // here and left no trace: the row stayed owed and the attempt was invisible.
  assert.equal(await refundPartyCheckout('checkout-1'), 'failed');
  assert.deepEqual(update.data.refundAttempts, { increment: 1 });
  assert.ok(update.data.lastRefundFailureAt instanceof Date);
});
