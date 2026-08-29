import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { reconcilePartyCheckoutPayment } from '../routes/partyStripeWebhook';

/**
 * A Checkout Session Stripe has confirmed can never be paid. Set only after
 * asking Stripe, so it is the one pre-payment state that is safe to delete.
 */
export const ABANDONED = 'abandoned';

/**
 * Statuses from which a paid webhook can still arrive. `expired` is included
 * deliberately: it is our own hold timing out, not Stripe's, and the webhook
 * explicitly reconciles payments that land afterwards.
 */
const PAYABLE_STATUSES = ['creating', 'pending', 'expired'];

/**
 * Checkouts that still carry an obligation — money taken, money owed back, or
 * money that may yet arrive. The row is the only local pointer to the Stripe
 * charge, so anything matching this must survive until it is settled.
 */
export const unsettledCheckout = {
  OR: [
    { status: 'completed' },
    { status: 'refund-required', refundedAt: null },
    { status: { in: PAYABLE_STATUSES }, stripeSessionId: { not: null }, refundedAt: null },
  ],
};

/** Money actually owed to someone, as opposed to a sale that completed cleanly. */
export const owedCheckout = {
  OR: [
    { status: 'refund-required', refundedAt: null },
    { status: { in: PAYABLE_STATUSES }, stripeSessionId: { not: null }, refundedAt: null },
  ],
};

type SettlementStripe = { checkout: { sessions: { retrieve: (id: string) => Promise<Stripe.Checkout.Session> } } };

/**
 * How many sessions one deletion attempt will settle. A party can hold
 * thousands of checkouts, and settling them all inline would hang the request
 * and hammer Stripe. Anything left over keeps blocking, so the host simply
 * retries rather than deleting something unsettled.
 */
const SETTLEMENT_BATCH = 50;

/**
 * Ask Stripe about every checkout that might still be holding money, so a
 * host is not blocked forever by a guest who opened a checkout and walked
 * away. A session Stripe reports as paid is reconciled (granting the pass or
 * marking the refund owed) and therefore stays undeletable; one Stripe
 * reports as expired and unpaid can never be paid, and is marked abandoned.
 *
 * Anything we cannot resolve is left exactly as it is, so the deletion guard
 * refuses: a host waiting is recoverable, a guest paying into a party whose
 * ledger we deleted is not.
 */
export async function settlePartyCheckoutsForDeletion(partyId: string, stripe?: SettlementStripe): Promise<void> {
  const pending = await db.partyCheckout.findMany({
    where: { partyId, status: { in: PAYABLE_STATUSES }, stripeSessionId: { not: null }, refundedAt: null },
    select: { id: true, userId: true, stripeSessionId: true },
    take: SETTLEMENT_BATCH,
  });
  if (pending.length === 0) return;

  const client = stripe ?? (config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null);
  if (!client) return;

  for (const checkout of pending) {
    try {
      const session = await client.checkout.sessions.retrieve(checkout.stripeSessionId as string);
      if (session.payment_status === 'paid') {
        const paidAt = new Date((session.created ?? Math.floor(Date.now() / 1000)) * 1000);
        await reconcilePartyCheckoutPayment(session, checkout.id, partyId, checkout.userId, paidAt);
      } else if (session.status === 'expired' && session.payment_status === 'unpaid') {
        await db.partyCheckout.updateMany({
          where: { id: checkout.id, status: { in: PAYABLE_STATUSES }, refundedAt: null },
          data: { status: ABANDONED },
        });
      }
    } catch (err) {
      // Leave the row unsettled; the deletion guard is what fails closed. The
      // host sees a refused delete, so this must be visible to an operator.
      console.error('[party-checkout-settlement] could not settle checkout', { checkoutId: checkout.id, partyId });
      captureError(err, { job: 'party-checkout-settlement', checkoutId: checkout.id });
    }
  }
}
