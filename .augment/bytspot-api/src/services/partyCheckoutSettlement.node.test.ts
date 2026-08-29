import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { ABANDONED, owedCheckout, settlePartyCheckoutsForDeletion, unsettledCheckout } from './partyCheckoutSettlement';

const checkout = db.partyCheckout as any;
const pendingRow = { id: 'checkout-1', userId: 'guest-user', stripeSessionId: 'cs_test_1' };

beforeEach(() => {
  checkout.findMany = async () => [pendingRow];
  checkout.updateMany = async () => ({ count: 1 });
  checkout.findUnique = async () => null;
});

test('A hold that timed out locally is still treated as payable', () => {
  // Our own hold expiring says nothing about Stripe's session, which can still
  // be paid. `expired` must therefore stay in both money predicates.
  const payable = unsettledCheckout.OR[2] as any;
  assert.deepEqual(payable.status.in, ['creating', 'pending', 'expired']);
  assert.deepEqual(payable.stripeSessionId, { not: null });
  assert.equal(payable.refundedAt, null);

  // A completed sale is an obligation for deletion but is not money owed, so a
  // buyer who paid cleanly can still be purged.
  assert.deepEqual(unsettledCheckout.OR[0], { status: 'completed' });
  assert.equal(owedCheckout.OR.some((clause: any) => clause.status === 'completed'), false);
  assert.deepEqual(owedCheckout.OR[0], { status: 'refund-required', refundedAt: null });
});

test('A session Stripe reports expired and unpaid is marked abandoned', async () => {
  let update: any;
  checkout.updateMany = async (args: any) => { update = args; return { count: 1 }; };

  await settlePartyCheckoutsForDeletion('party-1', {
    checkout: { sessions: { retrieve: async () => ({ status: 'expired', payment_status: 'unpaid' }) as any } },
  });

  // Stripe has confirmed no money can arrive, so the row stops blocking the
  // host's deletion — but only for rows that are still unpaid and unrefunded.
  assert.equal(update.data.status, ABANDONED);
  assert.equal(update.where.id, 'checkout-1');
  assert.equal(update.where.refundedAt, null);
});

test('A session Stripe reports paid is reconciled, never abandoned', async () => {
  let updated = false;
  checkout.updateMany = async () => { updated = true; return { count: 1 }; };

  // Reconciliation reads the checkout back; a missing row makes it throw, which
  // the caller swallows. What matters is that the row is not marked abandoned:
  // money arrived, so the ledger must survive for the pass or the refund.
  await settlePartyCheckoutsForDeletion('party-1', {
    checkout: { sessions: { retrieve: async () => ({ id: 'cs_test_1', status: 'complete', payment_status: 'paid' }) as any } },
  });

  assert.equal(updated, false);
});

test('An expired session Stripe will not call unpaid is left blocking', async () => {
  let updated = false;
  checkout.updateMany = async () => { updated = true; return { count: 1 }; };

  // Expiry alone is not proof no money moved. Only the explicit pair — expired
  // and unpaid — retires a row, so a discount, a free trial or a delayed
  // method that leaves another payment_status keeps the ledger.
  for (const paymentStatus of ['paid', 'no_payment_required', undefined]) {
    await settlePartyCheckoutsForDeletion('party-1', {
      checkout: { sessions: { retrieve: async () => ({ status: 'expired', payment_status: paymentStatus }) as any } },
    });
  }

  assert.equal(updated, false);
});

test('A session Stripe cannot be reached about is left blocking the delete', async () => {
  let updated = false;
  checkout.updateMany = async () => { updated = true; return { count: 1 }; };

  await settlePartyCheckoutsForDeletion('party-1', {
    checkout: { sessions: { retrieve: async () => { throw new Error('stripe unreachable'); } } },
  });

  // Failing to clear the row is the safe outcome: the deletion guard refuses,
  // which costs the host a retry instead of stranding a guest's payment.
  assert.equal(updated, false);
});

test('An open session is left alone, and no Stripe call is made without pending rows', async () => {
  let updated = false;
  checkout.updateMany = async () => { updated = true; return { count: 1 }; };
  await settlePartyCheckoutsForDeletion('party-1', {
    checkout: { sessions: { retrieve: async () => ({ status: 'open', payment_status: 'unpaid' }) as any } },
  });
  assert.equal(updated, false);

  checkout.findMany = async () => [];
  await settlePartyCheckoutsForDeletion('party-1', {
    checkout: { sessions: { retrieve: async () => { throw new Error('should not be called'); } } },
  });
});
