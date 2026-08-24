import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { beforeEach, test } from 'node:test';
import express from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import partyStripeWebhookRouter, { partyCheckoutMetadata, PartyCheckoutValidationError, reconcilePartyCheckoutPayment } from './partyStripeWebhook';

const partyCheckout = db.partyCheckout as any;
const partyGuest = db.partyGuest as any;
const party = db.party as any;
const user = db.user as any;
const prisma = db as any;
const future = () => new Date(Date.now() + 60_000);

function session(overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_test_1', amount_total: 2500, currency: 'usd',
    metadata: { kind: 'party-ticket', checkoutId: 'checkout-1', partyId: 'party-1', userId: 'user-1', ticketTierName: 'First Drop' },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function reservation(status = 'pending', reservationExpiresAt = future()) {
  return {
    id: 'checkout-1', partyId: 'party-1', userId: 'user-1', partyGuestId: 'guest-1', ticketTierName: 'First Drop',
    amountCents: 2500, currency: 'usd', status, reservationExpiresAt, stripeSessionId: null,
  };
}

function event(sessionPayload: Stripe.Checkout.Session, type = 'checkout.session.completed'): Stripe.Event {
  return {
    id: 'evt_test_1',
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: sessionPayload },
  } as Stripe.Event;
}

async function deliverSignedEvent(payload: Stripe.Event) {
  const body = JSON.stringify(payload);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: config.stripeWebhookSecret });
  const app = express();
  app.use(partyStripeWebhookRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/stripe/party`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

beforeEach(() => {
  (config as any).stripeSecretKey = 'sk_test_party_webhook';
  (config as any).stripeWebhookSecret = 'whsec_party_webhook';
  partyCheckout.findUnique = async () => reservation();
  partyCheckout.updateMany = async () => ({ count: 1 });
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'checkout-pending' });
  partyGuest.update = async () => ({ id: 'guest-1' });
  party.findUnique = async () => ({ requiredMembershipTier: 'black', ticketTiers: [{ name: 'First Drop', requiredMembershipTier: 'black' }] });
  user.findUnique = async () => ({ membershipTier: 'black' });
  prisma.$transaction = async (callback: any) => callback({ partyCheckout, partyGuest, party, user });
});

test('Party webhook classifies complete authoritative metadata even without the kind marker', () => {
  const metadata = partyCheckoutMetadata(session({
    metadata: { checkoutId: 'checkout-1', partyId: 'party-1', userId: 'user-1', ticketTierName: 'First Drop' },
  }));

  assert.equal(metadata.hasPartyIdentifiers, true);
  assert.equal(metadata.kind, null);
});

test('Party webhook does not classify partial Party metadata as a checkout', () => {
  const metadata = partyCheckoutMetadata(session({
    metadata: { kind: 'party-ticket', checkoutId: 'checkout-1', partyId: 'party-1' },
  }));

  assert.equal(metadata.hasPartyIdentifiers, false);
  assert.equal(metadata.kind, 'party-ticket');
});

test('signed paid Party event with complete identifiers reconciles without the kind marker', async () => {
  let guestUpdate: any;
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  const result = await deliverSignedEvent(event(session({
    mode: 'payment', payment_status: 'paid',
    metadata: { checkoutId: 'checkout-1', partyId: 'party-1', userId: 'user-1', ticketTierName: 'First Drop' },
  })));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { received: true });
  assert.deepEqual(guestUpdate.data, { status: 'ticketed', accessGranted: true, ticketTierName: 'First Drop' });
});

test('signed partial Party metadata is rejected before reconciliation', async () => {
  let checkoutLookups = 0;
  partyCheckout.findUnique = async () => { checkoutLookups += 1; return reservation(); };

  const result = await deliverSignedEvent(event(session({
    mode: 'payment', payment_status: 'paid',
    metadata: { kind: 'party-ticket', checkoutId: 'checkout-1', partyId: 'party-1' },
  })));

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: 'Incomplete Party Checkout metadata.' });
  assert.equal(checkoutLookups, 0);
});

test('signed expired Party event with complete identifiers expires its active reservation without the kind marker', async () => {
  let checkoutUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };

  const result = await deliverSignedEvent(event(session({
    metadata: { checkoutId: 'checkout-1', partyId: 'party-1', userId: 'user-1', ticketTierName: 'First Drop' },
  }), 'checkout.session.expired'));

  assert.equal(result.status, 200);
  assert.deepEqual(checkoutUpdate.where, { id: 'checkout-1', partyId: 'party-1', userId: 'user-1', status: { in: ['creating', 'pending'] } });
  assert.deepEqual(checkoutUpdate.data, { status: 'expired' });
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

test('Party webhook refunds a checkout when the user is downgraded before payment completes', async () => {
  let checkoutUpdate: any;
  let guestUpdate: any;
  user.findUnique = async () => ({ membershipTier: 'platinum' });
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());

  assert.equal(checkoutUpdate.data.status, 'refund-required');
  assert.deepEqual(guestUpdate.data, { status: 'refund-required', accessGranted: false });
});