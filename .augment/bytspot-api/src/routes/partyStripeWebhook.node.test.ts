import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type Stripe from 'stripe';
import { db } from '../lib/db';
import { PartyCheckoutValidationError, reconcilePartyCheckoutPayment } from './partyStripeWebhook';

const partyCheckout = db.partyCheckout as any;
const partyGuest = db.partyGuest as any;
const prisma = db as any;
const future = () => new Date(Date.now() + 60_000);

function session(overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_test_1', amount_total: 2500, currency: 'usd',
    metadata: { kind: 'party-ticket', checkoutId: 'checkout-1', partyId: 'party-1', userId: 'user-1', ticketTierName: 'First Drop' },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function reservation(status = 'pending', reservationExpiresAt = future()) {
  return {
    id: 'checkout-1', partyId: 'party-1', userId: 'user-1', partyGuestId: 'guest-1', ticketTierName: 'First Drop',
    amountCents: 2500, currency: 'usd', status, reservationExpiresAt, stripeSessionId: null,
  };
}

beforeEach(() => {
  partyCheckout.findUnique = async () => reservation();
  partyCheckout.updateMany = async () => ({ count: 1 });
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'checkout-pending' });
  partyGuest.update = async () => ({ id: 'guest-1' });
  prisma.$transaction = async (callback: any) => callback({ partyCheckout, partyGuest });
});

test('Party webhook confirms only a matching paid reservation and grants the pass', async () => {
  let checkoutUpdate: any;
  let guestUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());

  assert.equal(checkoutUpdate.data.status, 'completed');
  assert.equal(checkoutUpdate.data.stripeSessionId, 'cs_test_1');
  assert.deepEqual(guestUpdate.data, { status: 'ticketed', accessGranted: true, ticketTierName: 'First Drop' });
});

test('Party webhook rejects a mismatched amount before changing Party access', async () => {
  let transactionCalled = false;
  prisma.$transaction = async () => { transactionCalled = true; };

  await assert.rejects(() => reconcilePartyCheckoutPayment(session({ amount_total: 2501 }), 'checkout-1', 'party-1', 'user-1', new Date()), PartyCheckoutValidationError);
  assert.equal(transactionCalled, false);
});

test('Party webhook marks paid-after-decline reservations refund-required and accepts a retry', async () => {
  let checkoutUpdate: any;
  let guestUpdate: any;
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'declined' });
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());
  assert.equal(checkoutUpdate.data.status, 'refund-required');
  assert.deepEqual(guestUpdate.data, { status: 'refund-required', accessGranted: false });

  partyCheckout.findUnique = async () => reservation('refund-required');
  let retryUpdates = 0;
  partyCheckout.updateMany = async () => { retryUpdates += 1; return { count: 1 }; };
  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());
  assert.equal(retryUpdates, 0);
});

test('Party webhook grants a valid payment event delivered after the local hold expires', async () => {
  const paymentOccurredAt = new Date(Date.now() - 120_000);
  partyCheckout.findUnique = async () => reservation('pending', new Date(Date.now() - 60_000));
  let checkoutUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', paymentOccurredAt);

  assert.equal(checkoutUpdate.data.status, 'completed');
  assert.equal(checkoutUpdate.data.completedAt, paymentOccurredAt);
});

test('Party webhook makes a payment event created after hold expiry refund-required', async () => {
  partyCheckout.findUnique = async () => reservation('pending', new Date(Date.now() - 60_000));
  let checkoutUpdate: any;
  let guestUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());

  assert.equal(checkoutUpdate.data.status, 'refund-required');
  assert.deepEqual(guestUpdate.data, { status: 'refund-required', accessGranted: false });
});

test('Party webhook makes an out-of-order paid event for an expired reservation refund-required', async () => {
  partyCheckout.findUnique = async () => reservation('expired');
  let checkoutUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date(Date.now() - 120_000));

  assert.deepEqual(checkoutUpdate.where.status.in, ['creating', 'pending', 'expired']);
  assert.equal(checkoutUpdate.data.status, 'refund-required');
});