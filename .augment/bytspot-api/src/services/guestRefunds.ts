import type Stripe from 'stripe';
import { db } from '../lib/db';
import { refundableUntil } from '../lib/refundWindow';
import { captureError } from '../lib/observability';
import { deliverPushNotification } from './notificationDelivery';
import { refundPartyCheckout } from './stripeRisk';
import { stripeHandle } from '../vendor/payout';
import { VENDOR_TICKET_KIND } from '../vendor/tickets';

/** Why a guest cannot cancel and be refunded themselves; the message names the next step. */
export class GuestRefundRefused extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE') {
    super(message);
  }
}

export const GUEST_CANCEL_REASON = 'Cancelled by you';

/** Cancel one paid Party purchase (admission, table, or both) and refund it in full. */
export async function cancelPartyPurchase(
  userId: string,
  checkoutId: string,
  now: Date = new Date(),
  stripe: Stripe | null = stripeHandle.client(),
): Promise<{ checkoutId: string; refundedCents: number }> {
  const checkout = await db.partyCheckout.findFirst({
    where: { id: checkoutId, userId },
    select: {
      id: true, status: true, amountCents: true, ticketTierName: true,
      party: { select: { id: true, title: true, startsAt: true, hostUserId: true, cancelledAt: true } },
      guest: { select: { checkedInAt: true } },
      session: { select: { name: true } },
      payouts: { where: { status: { in: ['paid', 'reversed'] } }, select: { id: true } },
    },
  });
  // Someone else's purchase is indistinguishable from one that does not exist.
  if (!checkout) throw new GuestRefundRefused('Purchase not found.', 'NOT_FOUND');
  if (checkout.status === 'refunded') throw new GuestRefundRefused('This purchase was already refunded.', 'CONFLICT');
  if (checkout.status !== 'completed') throw new GuestRefundRefused('Only a paid purchase can be cancelled.', 'CONFLICT');
  if (checkout.guest.checkedInAt) throw new GuestRefundRefused('You already checked in, so this cannot be refunded here.', 'CONFLICT');
  if (now >= refundableUntil(checkout.party.startsAt)) {
    throw new GuestRefundRefused('Refunds close 24 hours before the party starts. Contact the host.', 'CONFLICT');
  }
  // Hosts are paid after the night; one already paid cannot be undone from here.
  if (checkout.payouts.length > 0) throw new GuestRefundRefused('The host has already been paid for this. Contact the host.', 'CONFLICT');
  if (!stripe) throw new GuestRefundRefused('Refunds are unavailable right now. Try again shortly.', 'SERVICE_UNAVAILABLE');

  const result = await refundPartyCheckout(checkout.id, GUEST_CANCEL_REASON, stripe, { statuses: ['completed'], now });
  if (result === 'failed') throw new GuestRefundRefused('The refund could not be sent. Try again shortly.', 'SERVICE_UNAVAILABLE');
  if (result === 'skipped') throw new GuestRefundRefused('This purchase was already refunded.', 'CONFLICT');

  const what = [checkout.ticketTierName, checkout.session?.name].filter(Boolean).join(' + ') || 'A purchase';
  void deliverPushNotification({
    userIds: [checkout.party.hostUserId],
    category: 'reservations',
    title: `Cancelled: ${checkout.party.title}`,
    body: `${what} was cancelled and refunded. The spot is open again.`,
    url: `https://bytspot.app/party/${checkout.party.id}`,
    type: 'party-guest-cancelled',
  }).catch((err: any) => console.error('[guest-refund] host notice failed:', err?.message));
  return { checkoutId: checkout.id, refundedCents: checkout.amountCents };
}

/** Cancel one paid business ticket and refund it in full. The business's share is taken back from its payout. */
export async function cancelTicketOrder(
  userId: string,
  orderId: string,
  now: Date = new Date(),
  stripe: Stripe | null = stripeHandle.client(),
): Promise<{ orderId: string; refundedCents: number }> {
  const order = await db.vendorTicketOrder.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true, status: true, amountCents: true, paymentIntentId: true, checkedInAt: true, ticketId: true,
      ticket: { select: { title: true, startsAt: true, location: { select: { label: true } }, seller: { select: { seats: { select: { role: true, state: true, userId: true } } } } } },
    },
  });
  if (!order) throw new GuestRefundRefused('Ticket not found.', 'NOT_FOUND');
  if (order.status === 'refunded') throw new GuestRefundRefused('This ticket was already refunded.', 'CONFLICT');
  if (order.status !== 'completed' || !order.paymentIntentId) throw new GuestRefundRefused('Only a paid ticket can be cancelled.', 'CONFLICT');
  if (order.checkedInAt) throw new GuestRefundRefused('You already checked in, so this cannot be refunded here.', 'CONFLICT');
  if (now >= refundableUntil(order.ticket.startsAt)) {
    throw new GuestRefundRefused(`Refunds close 24 hours before it starts. Contact ${order.ticket.location.label}.`, 'CONFLICT');
  }
  if (!stripe) throw new GuestRefundRefused('Refunds are unavailable right now. Try again shortly.', 'SERVICE_UNAVAILABLE');

  let refund: Stripe.Refund;
  try {
    // The business gives back its share and Bytspot its fee, so the guest is
    // made whole; Stripe's own fee stays with Bytspot.
    refund = await stripe.refunds.create(
      {
        payment_intent: order.paymentIntentId,
        reverse_transfer: true,
        refund_application_fee: true,
        reason: 'requested_by_customer',
        metadata: { kind: VENDOR_TICKET_KIND, orderId: order.id, reason: GUEST_CANCEL_REASON },
      },
      { idempotencyKey: `vendor-ticket-guest-cancel-${order.id}` },
    );
  } catch (error) {
    captureError(error, { flow: 'vendor-ticket-guest-cancel', orderId: order.id });
    throw new GuestRefundRefused('The refund could not be sent. Try again shortly.', 'SERVICE_UNAVAILABLE');
  }
  await db.$transaction(async (tx) => {
    const moved = await tx.vendorTicketOrder.updateMany({
      where: { id: order.id, status: 'completed', checkedInAt: null },
      data: { status: 'refunded', refundId: refund.id, refundReason: GUEST_CANCEL_REASON },
    });
    if (moved.count === 1) {
      await tx.vendorTicket.updateMany({ where: { id: order.ticketId, sold: { gt: 0 } }, data: { sold: { decrement: 1 } } });
    }
  });

  const owners = order.ticket.seller.seats
    .filter((seat) => seat.state === 'ACTIVE' && (seat.role === 'owner' || seat.role === 'manager'))
    .map((seat) => seat.userId);
  void deliverPushNotification({
    userIds: owners,
    category: 'reservations',
    title: `Ticket cancelled: ${order.ticket.title}`,
    body: 'A guest cancelled and was refunded. The ticket is back on sale.',
    url: 'https://bytspot.app/discover',
    type: 'vendor-ticket-guest-cancelled',
  }).catch((err: any) => console.error('[guest-refund] seller notice failed:', err?.message));
  return { orderId: order.id, refundedCents: order.amountCents };
}
