import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type Stripe from 'stripe';
import { db } from '../lib/db';
import { refundableUntil } from '../lib/refundWindow';
import { cancelPartyPurchase, cancelTicketOrder, GuestRefundRefused } from './guestRefunds';

const now = new Date('2026-12-01T12:00:00Z');
const inThreeDays = new Date(now.getTime() + 3 * 86_400_000);
const checkouts = db.partyCheckout as any;
const orders = db.vendorTicketOrder as any;
const saved = { findFirst: checkouts.findFirst, findUnique: checkouts.findUnique, orderFind: orders.findFirst, tx: (db as any).$transaction };
afterEach(() => {
  checkouts.findFirst = saved.findFirst; checkouts.findUnique = saved.findUnique; orders.findFirst = saved.orderFind; (db as any).$transaction = saved.tx;
});

function fakeStripe(onRefund: (params: any, options: any) => void = () => {}) {
  return { refunds: { create: async (params: any, options: any) => { onRefund(params, options); return { id: 're_1' }; } } } as unknown as Stripe;
}

function paidCheckout(over: Record<string, unknown> = {}) {
  return {
    id: 'co_1', status: 'completed', amountCents: 4500, ticketTierName: 'Door', paymentIntentId: 'pi_1',
    partyId: 'party-1', partyGuestId: 'guest-1', userId: 'user-1', sessionId: null,
    party: { id: 'party-1', title: 'Rooftop', startsAt: inThreeDays, hostUserId: 'host-1', cancelledAt: null },
    guest: { checkedInAt: null }, session: null, payouts: [], ...over,
  };
}

test('refunds close 24 hours before the start', () => {
  assert.equal(refundableUntil(inThreeDays).toISOString(), new Date(inThreeDays.getTime() - 86_400_000).toISOString());
});

test('a guest cancels a paid party purchase in full: Stripe refunds the charge and admission is revoked', async () => {
  const row = paidCheckout();
  checkouts.findFirst = async ({ where }: any) => (where.userId === 'user-1' ? row : null);
  checkouts.findUnique = async () => row;
  const writes: any = {};
  (db as any).$transaction = async (fn: any) => fn({
    partyCheckout: { updateMany: async (args: any) => ((writes.checkout = args), { count: 1 }) },
    partyGuest: { updateMany: async (args: any) => ((writes.guest = args), { count: 1 }) },
    partySessionClaim: { updateMany: async () => ({ count: 0 }) },
    partySession: { updateMany: async () => ({ count: 0 }) },
  });
  let refund: any;
  const result = await cancelPartyPurchase('user-1', 'co_1', now, fakeStripe((params, options) => (refund = { params, options })));
  assert.deepEqual(result, { checkoutId: 'co_1', refundedCents: 4500 });
  assert.equal(refund.params.payment_intent, 'pi_1');
  assert.equal(refund.params.amount, undefined, 'the whole charge is refunded');
  assert.equal(refund.options.idempotencyKey, 'party-refund:co_1');
  assert.equal(writes.checkout.data.status, 'refunded');
  assert.equal(writes.checkout.data.refundReason, 'Cancelled by you');
  assert.equal(writes.guest.data.accessGranted, false);
});

test('a party purchase is not refunded here when it is not yours, not paid, used, too close, or already paid out', async () => {
  const refuses = async (row: unknown, message: RegExp, at = now) => {
    checkouts.findFirst = async () => row;
    await assert.rejects(() => cancelPartyPurchase('user-1', 'co_1', at, fakeStripe(() => assert.fail('no refund'))),
      (error: unknown) => error instanceof GuestRefundRefused && message.test(error.message));
  };
  await refuses(null, /not found/);
  await refuses(paidCheckout({ status: 'pending' }), /Only a paid purchase/);
  await refuses(paidCheckout({ status: 'refunded' }), /already refunded/);
  await refuses(paidCheckout({ guest: { checkedInAt: now } }), /checked in/);
  await refuses(paidCheckout(), /24 hours before the party starts\. Contact the host/, new Date(inThreeDays.getTime() - 23 * 3_600_000));
  await refuses(paidCheckout({ payouts: [{ id: 'po' }] }), /already been paid/);
});

function paidOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'ord_1', status: 'completed', amountCents: 3000, paymentIntentId: 'pi_2', checkedInAt: null, ticketId: 'tk_1',
    ticket: { title: 'Jazz night', startsAt: inThreeDays, location: { label: 'Tribe & Spice' },
      seller: { seats: [{ role: 'owner', state: 'ACTIVE', userId: 'owner-1' }] } },
    ...over,
  };
}

test('a guest cancels a paid business ticket: the business gives back its share, the ticket goes back on sale', async () => {
  orders.findFirst = async ({ where }: any) => (where.userId === 'user-1' ? paidOrder() : null);
  const writes: any = {};
  (db as any).$transaction = async (fn: any) => fn({
    vendorTicketOrder: { updateMany: async (args: any) => ((writes.order = args), { count: 1 }) },
    vendorTicket: { updateMany: async (args: any) => ((writes.ticket = args), { count: 1 }) },
  });
  let refund: any;
  const result = await cancelTicketOrder('user-1', 'ord_1', now, fakeStripe((params, options) => (refund = { params, options })));
  assert.deepEqual(result, { orderId: 'ord_1', refundedCents: 3000 });
  assert.equal(refund.params.reverse_transfer, true);
  assert.equal(refund.params.refund_application_fee, true);
  assert.equal(refund.options.idempotencyKey, 'vendor-ticket-guest-cancel-ord_1');
  assert.deepEqual(writes.order.where, { id: 'ord_1', status: 'completed', checkedInAt: null });
  assert.equal(writes.order.data.status, 'refunded');
  assert.deepEqual(writes.ticket.data, { sold: { decrement: 1 } });
});

test('a business ticket is not refunded here when used, too close or not paid', async () => {
  const refuses = async (row: unknown, message: RegExp, at = now) => {
    orders.findFirst = async () => row;
    await assert.rejects(() => cancelTicketOrder('user-1', 'ord_1', at, fakeStripe(() => assert.fail('no refund'))),
      (error: unknown) => error instanceof GuestRefundRefused && message.test(error.message));
  };
  await refuses(null, /not found/);
  await refuses(paidOrder({ checkedInAt: now }), /checked in/);
  await refuses(paidOrder({ status: 'settling' }), /Only a paid ticket/);
  await refuses(paidOrder(), /Contact Tribe & Spice/, new Date(inThreeDays.getTime() - 3_600_000));
});

test('a refund Stripe refuses leaves the purchase paid and says to try again', async () => {
  orders.findFirst = async () => paidOrder();
  (db as any).$transaction = async () => assert.fail('nothing changes');
  const failing = { refunds: { create: async () => { throw new Error('card_declined'); } } } as unknown as Stripe;
  await assert.rejects(() => cancelTicketOrder('user-1', 'ord_1', now, failing), /could not be sent/);
});
