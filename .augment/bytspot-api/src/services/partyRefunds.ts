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
export async function refundPartyCheckout(checkoutId: string): Promise<RefundOutcome> {
  const checkout = await db.partyCheckout.findUnique({
    where: { id: checkoutId },
    select: { id: true, stripePaymentIntentId: true, destinationAccountId: true, refundedAt: true, status: true },
  });
  if (!checkout) return 'nothing-to-refund';
  if (checkout.refundedAt) return 'already-refunded';
  if (!checkout.stripePaymentIntentId) return 'nothing-to-refund';
  if (!config.stripeSecretKey) return 'failed';

  try {
    const stripe = new Stripe(config.stripeSecretKey);
    await stripe.refunds.create(
      {
        payment_intent: checkout.stripePaymentIntentId,
        reverse_transfer: Boolean(checkout.destinationAccountId),
        refund_application_fee: Boolean(checkout.destinationAccountId),
      },
      // Stripe collapses a retry of the same refund instead of issuing a
      // second one, which matters because webhooks are delivered more than
      // once by design.
      { idempotencyKey: `party-refund:${checkout.id}` },
    );
    await db.partyCheckout.update({ where: { id: checkout.id }, data: { refundedAt: new Date() } });
    return 'refunded';
  } catch (error) {
    // A failed refund must stay visible as refund-required rather than being
    // silently marked done; the guest is owed money either way.
    captureError(error, { checkoutId: checkout.id, scope: 'party-refund' });
    return 'failed';
  }
}
