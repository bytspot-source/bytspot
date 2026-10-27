import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { beforeEach, test } from 'node:test';
import express from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import partyStripeWebhookRouter, { partyCheckoutMetadata, PartyCheckoutValidationError, reconcilePartyCheckoutPayment } from './partyStripeWebhook';
import { chargeHoldReason, payoutDueAt, runPartyPayouts } from '../services/partyPayouts';
import { hostCanSellPaidTickets, partySellsPaidTickets } from '../services/hostPayouts';

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

test('Party webhook refunds a checkout paid after the host closed the room', async () => {
  const closedAt = new Date(Date.now() - 30_000);
  party.findUnique = async () => ({
    requiredMembershipTier: 'black',
    ticketTiers: [{ name: 'First Drop', requiredMembershipTier: 'black' }],
    closedAt,
  });
  let checkoutUpdate: any;
  let guestUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());

  assert.equal(checkoutUpdate.data.status, 'refund-required');
  assert.deepEqual(guestUpdate.data, { status: 'refund-required', accessGranted: false });
});

test('Party webhook refunds a checkout paid in the same second the host closed the room', async () => {
  const closedAt = new Date('2026-08-31T12:00:00.700Z');
  const paymentOccurredAt = new Date('2026-08-31T12:00:00.000Z');
  party.findUnique = async () => ({
    requiredMembershipTier: 'black',
    ticketTiers: [{ name: 'First Drop', requiredMembershipTier: 'black' }],
    closedAt,
  });
  let checkoutUpdate: any;
  let guestUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', paymentOccurredAt);

  assert.equal(checkoutUpdate.data.status, 'refund-required');
  assert.deepEqual(guestUpdate.data, { status: 'refund-required', accessGranted: false });
});

test('Party webhook still grants a payment that occurred before close when the webhook is delayed', async () => {
  const closedAt = new Date();
  const paymentOccurredAt = new Date(closedAt.getTime() - 60_000);
  party.findUnique = async () => ({
    requiredMembershipTier: 'black',
    ticketTiers: [{ name: 'First Drop', requiredMembershipTier: 'black' }],
    closedAt,
  });
  let checkoutUpdate: any;
  let guestUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async (input: any) => { guestUpdate = input; return { id: 'guest-1' }; };

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', paymentOccurredAt);

  assert.equal(checkoutUpdate.data.status, 'completed');
  assert.deepEqual(guestUpdate.data, { status: 'ticketed', accessGranted: true, ticketTierName: 'First Drop' });
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

test('A settled session purchase never rewrites the pass the guest already holds', async () => {
  // This is the sale the night is built on: the door was paid up front and a
  // promoter sold bottles to somebody already inside. Granting or clearing
  // admission here would rewrite a pass the guest is actively using.
  let guestWritten = false;
  let claim: any;
  const session1 = { id: 'session-1', quantity: 1, committed: 0 };
  partyGuest.update = async () => { guestWritten = true; return { id: 'guest-1' }; };
  partyCheckout.findUnique = async () => ({ ...reservation(), ticketTierName: null, sessionId: 'session-1', amountCents: 90000 });
  const partySession = {
    updateMany: async () => ({ count: 1 }),
    findUnique: async () => ({ requiredMembershipTier: null }),
    fields: { quantity: session1.quantity },
  };
  const partySessionClaim = { create: async (input: any) => { claim = input.data; return { id: 'claim-1' }; } };
  party.findUnique = async () => ({ requiredMembershipTier: 'green', ticketTiers: [], closedAt: null });
  prisma.$transaction = async (callback: any) => callback({ partyCheckout, partyGuest, party, user, partySession, partySessionClaim });

  const result = await deliverSignedEvent(event(session({
    mode: 'payment', payment_status: 'paid', amount_total: 90000,
    metadata: { checkoutId: 'checkout-1', partyId: 'party-1', userId: 'user-1', sessionId: 'session-1' },
  })));

  assert.equal(result.status, 200);
  assert.equal(guestWritten, false, 'admission is left exactly as the guest arrived with it');
  // The hold lives on its own row instead, so bottles and the door are
  // independently refundable.
  assert.deepEqual(claim, { sessionId: 'session-1', partyId: 'party-1', userId: 'user-1', state: 'held' });
});

test('A ticket tier that names no membership requirement is not treated as an unmet one', async () => {
  // meetsRequiredMembershipTier demands two real tiers, so asking it about an
  // absent requirement answered "not met" and refunded a paid ticket nobody
  // had objected to. An unstated requirement is not a failed one.
  let written: any;
  partyGuest.update = async (input: any) => { written = input.data; return { id: 'guest-1' }; };
  party.findUnique = async () => ({
    requiredMembershipTier: 'green',
    ticketTiers: [{ name: 'First Drop', requiredMembershipTier: null }],
    closedAt: null,
  });
  user.findUnique = async () => ({ membershipTier: 'green' });

  const result = await deliverSignedEvent(event(session({
    mode: 'payment', payment_status: 'paid',
    metadata: { checkoutId: 'checkout-1', partyId: 'party-1', userId: 'user-1', ticketTierName: 'First Drop' },
  })));

  assert.equal(result.status, 200);
  assert.deepEqual(written, { status: 'ticketed', accessGranted: true, ticketTierName: 'First Drop' });
});


test('A stated ticket-tier requirement is still enforced', async () => {
  // The allowance is for absence only. A tier that names black still refuses
  // a green guest, or the fix would sell past the requirement.
  let checkoutUpdate: any;
  user.findUnique = async () => ({ membershipTier: 'green' });
  party.findUnique = async () => ({ requiredMembershipTier: 'green', ticketTiers: [{ name: 'First Drop', requiredMembershipTier: 'black' }] });
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async () => ({ id: 'guest-1' });

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());
  assert.equal(checkoutUpdate.data.status, 'refund-required');
});

test('A missing Party requirement still fails closed', async () => {
  // The Party column is NOT NULL, so an absent requirement there is broken
  // data rather than an absence, and must not be waved through.
  let checkoutUpdate: any;
  user.findUnique = async () => ({ membershipTier: 'black' });
  party.findUnique = async () => ({ requiredMembershipTier: null, ticketTiers: [{ name: 'First Drop' }] });
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  partyGuest.update = async () => ({ id: 'guest-1' });

  await reconcilePartyCheckoutPayment(session(), 'checkout-1', 'party-1', 'user-1', new Date());
  assert.equal(checkoutUpdate.data.status, 'refund-required');
});

test('A confirmed payment records the charge it was paid by, for the payout later', async () => {
  let checkoutUpdate: any;
  partyCheckout.updateMany = async (input: any) => { checkoutUpdate = input; return { count: 1 }; };
  await reconcilePartyCheckoutPayment(session({ payment_intent: 'pi_party_1' }), 'checkout-1', 'party-1', 'user-1', new Date());
  assert.equal(checkoutUpdate.data.paymentIntentId, 'pi_party_1');
});

// ─── Host payouts ───────────────────────────────────────

type PayoutRow = { checkoutId: string; recipient: string; status: string; stripeTransferId?: string | null; detail?: string | null; destination?: string | null; amountCents?: number };

function payoutHarness(options: { hostStatus?: string; charge?: Partial<Stripe.Charge>; sellerActive?: boolean } = {}) {
  const rows: PayoutRow[] = [];
  const transfers: any[] = [];
  const checkout = {
    id: 'checkout-1', partyId: 'party-1', currency: 'usd', hostNetCents: 2250, sellerId: 'seller-1', sellerNetCents: 900,
    paymentIntentId: 'pi_party_1', stripeSessionId: 'cs_test_1',
    party: { hostUserId: 'host-1', startsAt: new Date('2026-10-30T22:00:00Z'), endsAt: new Date('2026-10-31T03:00:00Z') },
    payouts: [] as { recipient: string; status: string }[],
  };
  let lastQuery: any;
  partyCheckout.findMany = async (input: any) => { lastQuery = input; checkout.payouts = rows.map(({ recipient, status }) => ({ recipient, status })); return [checkout]; };
  const key = (where: any) => where.checkoutId_recipient;
  const find = (where: any) => rows.find((row) => row.checkoutId === key(where).checkoutId && row.recipient === key(where).recipient);
  prisma.partyPayoutTransfer = {
    findUnique: async ({ where }: any) => find(where) ?? null,
    create: async ({ data }: any) => { if (find({ checkoutId_recipient: data })) throw new Error('unique'); rows.push({ status: 'pending', ...data }); return data; },
    update: async ({ where, data }: any) => Object.assign(find(where)!, data),
    upsert: async ({ where, create, update }: any) => { const row = find(where); if (row) return Object.assign(row, update); rows.push({ ...create }); return create; },
  };
  prisma.hostPayoutAccount = {
    findUnique: async () => (options.hostStatus ? { stripeAccountId: 'acct_host', status: options.hostStatus, last4: '6789', detail: null } : null),
    update: async ({ data }: any) => ({ stripeAccountId: 'acct_host', ...data }),
  };
  prisma.vendorSeller = { findUnique: async () => ({ payoutReference: 'acct_seller', payoutStatus: options.sellerActive === false ? 'pending' : 'active' }) };
  const charge = { id: 'ch_party_1', status: 'succeeded', refunded: false, amount_refunded: 0, disputed: false, ...options.charge };
  const stripe = {
    accounts: { retrieve: async () => ({ payouts_enabled: options.hostStatus === 'active', details_submitted: true, requirements: { currently_due: [] }, external_accounts: { data: [] } }) },
    paymentIntents: { retrieve: async () => ({ latest_charge: charge }) },
    checkout: { sessions: { retrieve: async () => ({ payment_intent: 'pi_party_1' }) } },
    transfers: {
      list: async () => ({ data: transfers.map((t) => ({ ...t })) }),
      create: async (params: any, opts: any) => { const t = { id: `tr_${transfers.length + 1}`, ...params, idempotencyKey: opts.idempotencyKey, reversed: false }; transfers.push(t); return t; },
    },
  } as unknown as Stripe;
  return { rows, transfers, stripe, query: () => lastQuery };
}

async function withPayoutsOn<T>(run: () => Promise<T>): Promise<T> {
  const previous = { on: config.partyPayoutsEnabled, delay: config.partyPayoutDelayHours };
  (config as any).partyPayoutsEnabled = true;
  (config as any).partyPayoutDelayHours = 48;
  try { return await run(); } finally {
    (config as any).partyPayoutsEnabled = previous.on;
    (config as any).partyPayoutDelayHours = previous.delay;
  }
}

test('A sale is paid out 48 hours after the party ends, or after start plus six hours with no end', () => {
  assert.equal(payoutDueAt({ startsAt: new Date('2026-10-30T22:00:00Z'), endsAt: new Date('2026-10-31T03:00:00Z') }, 48).toISOString(), '2026-11-02T03:00:00.000Z');
  assert.equal(payoutDueAt({ startsAt: new Date('2026-10-30T22:00:00Z'), endsAt: null }, 48).toISOString(), '2026-11-02T04:00:00.000Z');
});

test('Host and business are each paid once from the sale\'s charge, and Bytspot keeps the rest', () => withPayoutsOn(async () => {
  const harness = payoutHarness({ hostStatus: 'active' });
  const now = new Date('2026-11-02T04:00:00Z');
  const result = await runPartyPayouts({ stripe: harness.stripe, now });
  assert.deepEqual(result, { paid: 2, held: 0, failed: 0, waiting: 0 });
  assert.deepEqual(harness.transfers.map((t) => [t.destination, t.amount, t.source_transaction, t.transfer_group, t.idempotencyKey]), [
    ['acct_host', 2250, 'ch_party_1', 'party-checkout:checkout-1', 'party-payout:checkout-1:host'],
    ['acct_seller', 900, 'ch_party_1', 'party-checkout:checkout-1', 'party-payout:checkout-1:seller'],
  ]);
  assert.ok(harness.rows.every((row) => row.status === 'paid' && row.stripeTransferId));
  // Only parties over by the delay are selected.
  assert.deepEqual(harness.query().where.party.OR[0], { endsAt: { lte: new Date('2026-10-31T04:00:00Z') } });
  // A second run sends nothing more.
  assert.deepEqual(await runPartyPayouts({ stripe: harness.stripe, now }), { paid: 0, held: 0, failed: 0, waiting: 0 });
  assert.equal(harness.transfers.length, 2);
}));

test('A retried transfer whose first attempt reached Stripe is not sent twice', () => withPayoutsOn(async () => {
  const harness = payoutHarness({ hostStatus: 'active', sellerActive: false });
  harness.transfers.push({ id: 'tr_earlier', metadata: { recipient: 'host' }, reversed: false });
  harness.rows.push({ checkoutId: 'checkout-1', recipient: 'host', status: 'failed' });
  const result = await runPartyPayouts({ stripe: harness.stripe, now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(result.paid, 1);
  assert.equal(harness.transfers.length, 1);
  assert.equal(harness.rows[0].stripeTransferId, 'tr_earlier');
}));

test('A refunded or disputed sale is held for a person, never paid automatically', () => withPayoutsOn(async () => {
  assert.equal(chargeHoldReason({ status: 'succeeded', refunded: false, amount_refunded: 500, disputed: false }), 'This charge was refunded.');
  assert.equal(chargeHoldReason({ status: 'succeeded', refunded: false, amount_refunded: 0, disputed: true }), 'The guest disputed this charge.');
  assert.equal(chargeHoldReason(null), 'Stripe has no charge for this sale.');
  const harness = payoutHarness({ hostStatus: 'active', charge: { disputed: true } });
  const result = await runPartyPayouts({ stripe: harness.stripe, now: new Date('2026-11-03T00:00:00Z') });
  assert.deepEqual(result, { paid: 0, held: 2, failed: 0, waiting: 0 });
  assert.equal(harness.transfers.length, 0);
  assert.ok(harness.rows.every((row) => row.status === 'held' && row.detail === 'The guest disputed this charge.'));
}));

test('A recipient without a working payout account waits, and the sale stays owed', () => withPayoutsOn(async () => {
  const harness = payoutHarness({ hostStatus: 'pending', sellerActive: false });
  const result = await runPartyPayouts({ stripe: harness.stripe, now: new Date('2026-11-03T00:00:00Z') });
  assert.deepEqual(result, { paid: 0, held: 0, failed: 0, waiting: 2 });
  assert.equal(harness.transfers.length, 0);
  assert.equal(harness.rows.length, 0);
}));

test('Nothing moves while party payouts are off', async () => {
  const harness = payoutHarness({ hostStatus: 'active' });
  (config as any).partyPayoutsEnabled = false;
  assert.deepEqual(await runPartyPayouts({ stripe: harness.stripe }), { paid: 0, held: 0, failed: 0, waiting: 0 });
  assert.equal(harness.transfers.length, 0);
});

test('Only paid parties need a payout account to publish, and only once payouts are on', async () => {
  assert.equal(partySellsPaidTickets([{ name: 'Free', priceCents: 0 }]), false);
  assert.equal(partySellsPaidTickets([{ name: 'Free', priceCents: 0 }, { name: 'VIP', priceCents: 2500 }]), true);
  assert.equal(partySellsPaidTickets(null), false);
  payoutHarness({});
  (config as any).partyPayoutsEnabled = false;
  assert.equal(await hostCanSellPaidTickets('host-1'), true);
  await withPayoutsOn(async () => {
    assert.equal(await hostCanSellPaidTickets('host-1'), false);
    payoutHarness({ hostStatus: 'active' });
    assert.equal(await hostCanSellPaidTickets('host-1'), true);
  });
});
