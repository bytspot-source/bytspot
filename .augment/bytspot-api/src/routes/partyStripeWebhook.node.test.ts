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

  assert.deepEqual(checkoutUpdate.where.status.in, ['creating', 'pending', 'expired', 'abandoned']);
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
test('Membership upgrade requires a Stripe signature', async () => {
  let updated = false;
  user.updateMany = async () => { updated = true; return { count: 1 }; };
  const app = express();
  app.use(partyStripeWebhookRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    // The forged payload that the retired tRPC procedure accepted verbatim.
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/stripe/party`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: { userId: 'user-1' } } } }),
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(updated, false);

  // The same forgery with a wrong secret is still refused.
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: { userId: 'user-1' } } } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_attacker_secret' });
  const forged = express();
  forged.use(partyStripeWebhookRouter);
  const forgedServer = forged.listen(0, '127.0.0.1');
  await once(forgedServer, 'listening');
  try {
    const port = (forgedServer.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/stripe/party`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body,
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => forgedServer.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(updated, false);
});

test('Signed subscription checkout upgrades the buyer without touching Black', async () => {
  let update: any;
  user.updateMany = async (input: any) => { update = input; return { count: 1 }; };

  const result = await deliverSignedEvent({
    type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cs_sub_1', mode: 'subscription', payment_status: 'paid', metadata: { userId: 'user-9' } } },
  } as unknown as Stripe.Event);

  assert.equal(result.status, 200);
  assert.deepEqual(update.where, { id: 'user-9', membershipTier: { not: 'black' } });
  assert.deepEqual(update.data, { isPremium: true, membershipTier: 'platinum' });
});

test('Signed subscription checkout grants nothing when unpaid or unattributed', async () => {
  let updated = false;
  user.updateMany = async () => { updated = true; return { count: 1 }; };

  for (const object of [
    { id: 'cs_sub_2', mode: 'subscription', payment_status: 'unpaid', metadata: { userId: 'user-9' } },
    { id: 'cs_sub_3', mode: 'subscription', payment_status: 'paid', metadata: {} },
  ]) {
    const result = await deliverSignedEvent({
      type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object },
    } as unknown as Stripe.Event);
    assert.equal(result.status, 200);
  }
  assert.equal(updated, false);
});

test('Signed cancellation downgrades Platinum by customer and leaves Black alone', async () => {
  let update: any;
  user.updateMany = async (input: any) => { update = input; return { count: 1 }; };

  const result = await deliverSignedEvent({
    type: 'customer.subscription.deleted', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'sub_1', customer: 'cus_123' } },
  } as unknown as Stripe.Event);

  assert.equal(result.status, 200);
  assert.deepEqual(update.where, { stripeCustomerId: 'cus_123', membershipTier: 'platinum' });
  assert.deepEqual(update.data, { isPremium: false, membershipTier: 'green' });
});

test('Party ticket payments are unaffected by the shared endpoint', async () => {
  let membershipTouched = false;
  user.updateMany = async () => { membershipTouched = true; return { count: 1 }; };
  let checkoutUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };

  const result = await deliverSignedEvent({
    type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { ...session(), mode: 'payment', payment_status: 'paid' } },
  } as unknown as Stripe.Event);

  assert.equal(result.status, 200);
  assert.equal(membershipTouched, false);
  assert.equal(checkoutUpdate.data.status, 'completed');
});

test('A refund-required payment records the charge so it can actually be refunded', async () => {
  let checkoutUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async () => ({ id: 'guest-1' });
  // The host declined while the guest was paying, so the pass is refused.
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'declined' });
  // Nothing to refund against yet: the PaymentIntent only exists now that the
  // Session is paid.
  partyCheckout.findUnique = async () => ({ ...reservation(), stripePaymentIntentId: null });

  await reconcilePartyCheckoutPayment(session({ payment_intent: 'pi_live_1' }), 'checkout-1', 'party-1', 'user-1', new Date());

  assert.equal(checkoutUpdate.data.status, 'refund-required');
  assert.equal(checkoutUpdate.data.stripePaymentIntentId, 'pi_live_1');
});

test('A redelivered webhook retries a refund that was owed but never issued', async () => {
  // The first delivery committed refund-required and the charge, then died
  // before Stripe was called. The guest is still owed money.
  partyCheckout.findUnique = async () => ({ ...reservation(), status: 'refund-required', refundedAt: null, stripePaymentIntentId: 'pi_live_1' });
  partyCheckout.updateMany = async () => ({ count: 0 });
  partyGuest.findUnique = async () => ({ id: 'guest-1', status: 'declined' });

  // Stripe is unreachable, so the webhook must not be acknowledged: a 500
  // buys another delivery instead of stranding the refund.
  await assert.rejects(() => reconcilePartyCheckoutPayment(session({ payment_intent: 'pi_live_1' }), 'checkout-1', 'party-1', 'user-1', new Date()));

  // Already refunded: a redelivery must not attempt a second refund.
  partyCheckout.findUnique = async () => ({ ...reservation(), status: 'refund-required', refundedAt: new Date(), stripePaymentIntentId: 'pi_live_1' });
  await reconcilePartyCheckoutPayment(session({ payment_intent: 'pi_live_1' }), 'checkout-1', 'party-1', 'user-1', new Date());
});

test('A paid event for a ledger whose party or buyer is gone becomes refund-required', async () => {
  const checkout = db.partyCheckout as any;
  let update: any;
  checkout.findUnique = async () => ({
    id: 'checkout-1', partyId: null, partyGuestId: null, userId: null, status: 'pending',
    ticketTierName: 'First Drop', amountCents: 2500, currency: 'usd', stripeSessionId: null, refundedAt: null,
    reservationExpiresAt: new Date(Date.now() + 60_000),
  });
  checkout.updateMany = async (args: any) => { update = args; return { count: 1 }; };

  // Erasure detaches the ledger rather than deleting it, so a late payment can
  // still arrive against a row that points at nobody. No pass is possible, so
  // the only honest outcome is that the money is owed back.
  await reconcilePartyCheckoutPayment(
    { id: 'cs_test_1', amount_total: 2500, currency: 'usd', metadata: { ticketTierName: 'First Drop' } } as any,
    'checkout-1', 'party-1', 'user-1', new Date(),
  );

  assert.equal(update.data.status, 'refund-required');
  assert.equal(update.where.refundedAt, null);
});
