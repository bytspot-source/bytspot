import type Stripe from 'stripe';
import type { OfferCheckout } from '@prisma/client';
import { config } from '../config';
import { db } from '../lib/db';
import { serializableTransactionWithRetry } from '../lib/transactions';
import { deliverPushNotification } from '../services/notificationDelivery';
import { currentPlatformFeeBps, splitBookingAmount, VENDOR_BOOKING_FEE_SCOPE } from '../services/platformFee';
import { acceptOffer, NotPayable, NotYours, OfferExpired, OfferGone, PayoutNotReady, SlotTaken } from './acceptOffer';

export { NotPayable, PayoutNotReady };
import { notifyOfferAcceptedSeller } from './askNotice';
import { stripeHandle } from './payout';

/**
 * Paying for an offer before it is accepted.
 *
 * The guest pays first and the table is committed when the payment is
 * confirmed. Nothing is held while they are on the processor's page: if the
 * slot goes in the meantime, or the seller withdraws, the charge is refunded in
 * full rather than turned into a booking that does not exist.
 *
 * Bytspot is the merchant of record (see `ensureAccount`), so the charge is
 * ours and the seller is paid by transfer, less the booking fee.
 */

export const OFFER_BOOKING_KIND = 'offer-booking';

/** Stripe will not expire a Checkout Session sooner than 30 minutes. */
const CHECKOUT_MINUTES = 31;

const OPEN_STATES = ['creating', 'pending'];

export class PaymentsUnavailable extends Error {
  constructor() {
    super('Paying in the app is not available right now.');
  }
}

/**
 * A hosted checkout URL for one offer.
 *
 * Asking twice returns the same open checkout rather than a second charge the
 * guest could complete in another tab.
 */
export async function startOfferCheckout(input: { offerId: string; userId: string; now?: Date }): Promise<{ url: string }> {
  const now = input.now ?? new Date();
  const stripe = stripeHandle.client();
  if (!stripe) throw new PaymentsUnavailable();

  const offer = await db.offer.findUnique({
    where: { id: input.offerId },
    include: {
      demand: { select: { raisedByUserId: true, state: true, partySize: true } },
      location: { select: { label: true } },
      seller: { select: { payoutReference: true, payoutStatus: true } },
    },
  });
  if (!offer) throw new OfferGone();
  if (offer.demand.raisedByUserId !== input.userId) throw new NotYours();
  if (offer.payAt !== 'bytspot' || offer.priceCents <= 0) throw new NotPayable();
  if (offer.state !== 'OFFERED' || offer.demand.state === 'BOOKED') throw new OfferGone();
  if (offer.holdExpiresAt <= now) throw new OfferExpired();
  if (offer.seller.payoutStatus !== 'active' || !offer.seller.payoutReference) throw new PayoutNotReady();
  const destination = offer.seller.payoutReference;

  const feeBps = await currentPlatformFeeBps(VENDOR_BOOKING_FEE_SCOPE, config.vendorBookingFeeBps);
  const { feeCents, sellerNetCents } = splitBookingAmount(offer.priceCents, feeBps, config.vendorBookingFeeMinCents);

  const reservation = await serializableTransactionWithRetry(async (tx) => {
    // One open checkout per offer, decided under the offer's own row.
    await tx.$queryRaw`SELECT "id" FROM "offers" WHERE "id" = ${offer.id} FOR UPDATE`;
    await tx.offerCheckout.updateMany({
      where: { offerId: offer.id, status: { in: OPEN_STATES }, expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    const completed = await tx.offerCheckout.findFirst({ where: { offerId: offer.id, status: 'completed' } });
    if (completed) throw new OfferGone();
    const open = await tx.offerCheckout.findFirst({
      where: { offerId: offer.id, userId: input.userId, status: { in: OPEN_STATES }, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (open) return open;
    return tx.offerCheckout.create({
      data: {
        offerId: offer.id,
        userId: input.userId,
        sellerId: offer.sellerId,
        destination,
        amountCents: offer.priceCents,
        platformFeeBps: feeBps,
        platformFeeCents: feeCents,
        sellerNetCents,
        currency: 'usd',
        status: 'creating',
        expiresAt: new Date(now.getTime() + CHECKOUT_MINUTES * 60_000),
      },
    });
  }, 'Another payment for this offer is starting. Try again.');

  if (reservation.status === 'pending' && reservation.checkoutUrl) return { url: reservation.checkoutUrl };

  const guests = `${offer.demand.partySize} ${offer.demand.partySize === 1 ? 'guest' : 'guests'}`;
  const back = `${config.frontendUrl}/?demand=${encodeURIComponent(offer.demandId)}`;
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: reservation.currency,
            unit_amount: reservation.amountCents,
            product_data: { name: offer.location.label, description: guests },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: reservation.platformFeeCents,
        transfer_data: { destination: reservation.destination },
        metadata: { kind: OFFER_BOOKING_KIND, checkoutId: reservation.id, offerId: offer.id },
      },
      metadata: { kind: OFFER_BOOKING_KIND, checkoutId: reservation.id, offerId: offer.id, userId: input.userId },
      expires_at: Math.floor(reservation.expiresAt.getTime() / 1000),
      custom_text: {
        submit: { message: 'Refunds after booking are handled by Bytspot support.' },
      },
      success_url: `${back}&checkout=offer-paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${back}&checkout=offer-cancelled`,
    },
    { idempotencyKey: `offer-checkout-${reservation.id}` },
  );
  if (!session.url) throw new Error('Stripe Checkout did not return a hosted URL.');

  await db.offerCheckout.updateMany({
    where: { id: reservation.id, status: 'creating' },
    data: { status: 'pending', stripeSessionId: session.id, checkoutUrl: session.url },
  });
  return { url: session.url };
}

export type SettledAs = 'completed' | 'refunded' | 'ignored';

/**
 * Turn a confirmed payment into a booking, or give the money back.
 *
 * Safe to run more than once for the same session: Stripe redelivers, and a
 * delivery that booked the table but died before recording it must finish the
 * job rather than refund a guest who has a table.
 */
export async function settleOfferCheckout(session: Stripe.Checkout.Session, stripe: Stripe): Promise<SettledAs> {
  const checkoutId = session.metadata?.checkoutId;
  if (!checkoutId) return 'ignored';
  const checkout = await db.offerCheckout.findUnique({ where: { id: checkoutId } });
  if (!checkout) throw new Error('Offer checkout was not found.');
  if (checkout.stripeSessionId && checkout.stripeSessionId !== session.id) throw new Error('Offer checkout session mismatch.');
  if (checkout.status === 'completed') return 'completed';
  if (checkout.status === 'refunded') return 'refunded';

  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;

  if (session.amount_total !== checkout.amountCents || session.currency?.toLowerCase() !== checkout.currency) {
    return refund(checkout, session.id, paymentIntentId, 'The amount paid did not match the offer.', stripe);
  }
  const winner = await db.offerCheckout.findFirst({ where: { offerId: checkout.offerId, status: 'completed', id: { not: checkout.id } } });
  if (winner) return refund(checkout, session.id, paymentIntentId, 'This offer was already paid for.', stripe);

  try {
    // Judged as of when checkout began, so a guest who started inside the hold
    // is not refused for a slow card.
    await acceptOffer({ offerId: checkout.offerId, userId: checkout.userId, now: checkout.createdAt, paid: true });
  } catch (error) {
    if (!(error instanceof OfferGone || error instanceof OfferExpired || error instanceof SlotTaken || error instanceof NotYours)) {
      throw error;
    }
    const offer = await db.offer.findUnique({ where: { id: checkout.offerId }, select: { state: true } });
    if (offer?.state !== 'ACCEPTED') return refund(checkout, session.id, paymentIntentId, error.message, stripe);
  }

  await db.offerCheckout.updateMany({
    where: { id: checkout.id, status: { in: [...OPEN_STATES, 'expired'] } },
    data: { status: 'completed', completedAt: new Date(), stripeSessionId: session.id, paymentIntentId },
  });
  void notifyOfferAcceptedSeller(checkout.offerId, { sellerNetCents: checkout.sellerNetCents });
  return 'completed';
}

async function refund(
  checkout: OfferCheckout,
  sessionId: string,
  paymentIntentId: string | null,
  reason: string,
  stripe: Stripe,
): Promise<SettledAs> {
  if (!paymentIntentId) throw new Error('A paid offer checkout has no payment to refund.');
  const refunded = await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      reverse_transfer: true,
      refund_application_fee: true,
      metadata: { kind: OFFER_BOOKING_KIND, checkoutId: checkout.id },
    },
    { idempotencyKey: `offer-refund-${checkout.id}` },
  );
  await db.offerCheckout.updateMany({
    where: { id: checkout.id, status: { in: [...OPEN_STATES, 'expired'] } },
    data: { status: 'refunded', refundId: refunded.id, refundReason: reason, stripeSessionId: sessionId, paymentIntentId },
  });
  void deliverPushNotification({
    userIds: [checkout.userId],
    category: 'reservations',
    title: 'You were refunded',
    body: `${reason} Your payment is on its way back.`,
    url: '/requests',
    type: 'offer-refunded',
  }).catch((err: any) => console.error('[offer-checkout] refund notice failed:', err?.message));
  return 'refunded';
}

/**
 * Claim offer-booking events from the shared Stripe endpoint.
 *
 * Returns false for anything that is not ours, so the caller can hand the
 * event on. Throwing means the caller should answer 500 and let Stripe retry.
 */
export async function applyOfferCheckoutEvent(event: Stripe.Event): Promise<boolean> {
  if (!event.type.startsWith('checkout.session.')) return false;
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.metadata?.kind !== OFFER_BOOKING_KIND) return false;
  const checkoutId = session.metadata?.checkoutId;
  if (!checkoutId) {
    console.warn('[offer-checkout] signed event without a checkout id', { eventType: event.type });
    return true;
  }

  if (event.type === 'checkout.session.expired') {
    await db.offerCheckout.updateMany({
      where: { id: checkoutId, status: { in: OPEN_STATES } },
      data: { status: 'expired' },
    });
    return true;
  }
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return true;
  if (session.mode !== 'payment' || session.payment_status !== 'paid') return true;

  const stripe = stripeHandle.client();
  if (!stripe) throw new Error('Stripe is not configured.');
  await settleOfferCheckout(session, stripe);
  return true;
}
