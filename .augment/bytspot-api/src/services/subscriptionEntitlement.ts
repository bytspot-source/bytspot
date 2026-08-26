import type Stripe from 'stripe';
import { db } from '../lib/db';

function customerId(customer: Stripe.Subscription['customer']): string | null {
  if (typeof customer === 'string') return customer.trim() || null;
  return customer?.id?.trim() || null;
}

/**
 * Membership transitions driven by Stripe. Callers must hand this a
 * signature-verified event: the entitlement it grants is the one the product
 * charges for, so an unverified payload would be a free upgrade.
 *
 * Returns true once the event is claimed as a subscription transition, letting
 * the caller stop treating it as a Party checkout.
 */
export async function applySubscriptionEvent(event: Stripe.Event): Promise<boolean> {
  if (event.type === 'customer.subscription.deleted') {
    const id = customerId((event.data.object as Stripe.Subscription).customer);
    if (!id) {
      console.warn('[subscription-webhook] cancellation without a customer', { eventType: event.type });
      return true;
    }
    // Black is granted out of band, so a lapsed card must not strip it.
    await db.user.updateMany({
      where: { stripeCustomerId: id, membershipTier: 'platinum' },
      data: { isPremium: false, membershipTier: 'green' },
    });
    return true;
  }

  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return false;
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== 'subscription') return false;

  const userId = session.metadata?.userId?.trim();
  if (!userId) {
    console.warn('[subscription-webhook] subscription checkout without a userId', { eventType: event.type, sessionId: session.id });
    return true;
  }
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    console.info('[subscription-webhook] subscription checkout not yet paid', { eventType: event.type, paymentStatus: session.payment_status ?? null });
    return true;
  }

  await db.user.updateMany({
    where: { id: userId, membershipTier: { not: 'black' } },
    data: { isPremium: true, membershipTier: 'platinum' },
  });
  return true;
}
