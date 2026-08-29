import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';

export type RefundOutcome = 'refunded' | 'already-refunded' | 'nothing-to-refund' | 'failed';

/**
 * Return a guest's money and unwind the split with it.
 *
 * A destination charge has already moved the host's net into their connected
 * balance, so refunding the guest alone would leave Bytspot funding the
 * difference out of its own account. `reverse_transfer` claws the host's share
 * back, and `refund_application_fee` gives up Bytspot's fee: no fee on a
 * refunded sale is a policy, not an implementation detail.
 *
 * A sale made before the payout rail existed has no destination, so there is
 * no transfer to reverse and a plain refund is the whole job.
 */
export type RefundStripe = Pick<Stripe, 'refunds'> & { checkout: Pick<Stripe['checkout'], 'sessions'> };

/**
 * Every route out of a failed refund records the attempt, so an obligation that
 * keeps failing is queryable rather than only present in an error feed. A
 * missing Stripe key and a paid checkout with no charge behind it are failures
 * too — they were the two that previously left no trace at all.
 */
async function recordRefundFailure(checkoutId: string): Promise<RefundOutcome> {
  await db.partyCheckout.update({
    where: { id: checkoutId },
    data: { refundAttempts: { increment: 1 }, lastRefundFailureAt: new Date() },
  }).catch(() => undefined);
  return 'failed';
}

export async function refundPartyCheckout(checkoutId: string, stripeClient?: RefundStripe): Promise<RefundOutcome> {
  const checkout = await db.partyCheckout.findUnique({
    where: { id: checkoutId },
    select: { id: true, stripePaymentIntentId: true, stripeSessionId: true, destinationAccountId: true, refundedAt: true, status: true },
  });
  if (!checkout) return 'nothing-to-refund';
  if (checkout.refundedAt) return 'already-refunded';
  // No session means no charge was ever made under this reservation.
  if (!checkout.stripePaymentIntentId && !checkout.stripeSessionId) return 'nothing-to-refund';
  if (!config.stripeSecretKey) return recordRefundFailure(checkout.id);

  try {
    const stripe = stripeClient ?? new Stripe(config.stripeSecretKey);
    // Sales made before the PaymentIntent was recorded - and any row written
    // by an older build - still have a session to read the charge back from.
    const paymentIntentId = checkout.stripePaymentIntentId
      ?? (await stripe.checkout.sessions.retrieve(checkout.stripeSessionId as string)).payment_intent;
    const intentId = typeof paymentIntentId === 'string' ? paymentIntentId : paymentIntentId?.id ?? null;
    // A paid checkout with no charge behind it is a contradiction; report
    // failure so it stays refund-required and visible.
    if (!intentId) return recordRefundFailure(checkout.id);
    await stripe.refunds.create(
      {
        payment_intent: intentId,
        reverse_transfer: Boolean(checkout.destinationAccountId),
        refund_application_fee: Boolean(checkout.destinationAccountId),
      },
      // Stripe collapses a retry of the same refund instead of issuing a
      // second one, which matters because webhooks are delivered more than
      // once by design.
      { idempotencyKey: `party-refund:${checkout.id}` },
    );
    await db.partyCheckout.update({ where: { id: checkout.id }, data: { refundedAt: new Date(), stripePaymentIntentId: intentId } });
    return 'refunded';
  } catch (error) {
    // A failed refund must stay visible as refund-required rather than being
    // silently marked done; the guest is owed money either way.
    captureError(error, { checkoutId: checkout.id, scope: 'party-refund' });
    return recordRefundFailure(checkout.id);
  }
}
