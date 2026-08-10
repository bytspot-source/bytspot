import { raw, Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { meetsRequiredMembershipTier } from '../lib/membershipTier';

const partyStripeWebhookRouter = Router();

function metadataValue(metadata: Stripe.Metadata | null, key: string): string | null {
  const value = metadata?.[key]?.trim();
  return value || null;
}

export class PartyCheckoutValidationError extends Error {}

function ticketRequiredMembershipTier(ticketTiers: unknown, ticketTierName: string): unknown {
  if (!Array.isArray(ticketTiers)) return null;
  return ticketTiers.find((tier): tier is { name: unknown; requiredMembershipTier: unknown } => Boolean(tier) && typeof tier === 'object' && 'name' in tier && 'requiredMembershipTier' in tier && (tier as { name: unknown }).name === ticketTierName)?.requiredMembershipTier ?? null;
}

export async function reconcilePartyCheckoutPayment(session: Stripe.Checkout.Session, checkoutId: string, partyId: string, userId: string, paymentOccurredAt: Date): Promise<void> {
  const checkout = await db.partyCheckout.findUnique({ where: { id: checkoutId } });
  if (!checkout) throw new Error('Party Checkout reservation was not found.');
  const expectedTier = metadataValue(session.metadata, 'ticketTierName');
  if (checkout.partyId !== partyId || checkout.userId !== userId || checkout.ticketTierName !== expectedTier || checkout.amountCents !== session.amount_total || checkout.currency !== session.currency?.toLowerCase()) {
    throw new PartyCheckoutValidationError('Party Checkout values did not match the reservation.');
  }

  await db.$transaction(async (tx) => {
    const current = await tx.partyCheckout.findUnique({ where: { id: checkout.id } });
    if (!current || current.status === 'completed' || current.status === 'refund-required') return;
    if (current.stripeSessionId && current.stripeSessionId !== session.id) throw new Error('Party Checkout session mismatch.');
    const [guest, party, user] = await Promise.all([
      tx.partyGuest.findUnique({ where: { id: current.partyGuestId } }),
      tx.party.findUnique({ where: { id: current.partyId }, select: { requiredMembershipTier: true, ticketTiers: true } }),
      tx.user.findUnique({ where: { id: current.userId }, select: { membershipTier: true } }),
    ]);
    if (!guest) throw new Error('Party guest is not eligible for payment confirmation.');
    const ticketTierRequirement = ticketRequiredMembershipTier(party?.ticketTiers, current.ticketTierName);
    const membershipEligible = meetsRequiredMembershipTier(user?.membershipTier, party?.requiredMembershipTier)
      && meetsRequiredMembershipTier(user?.membershipTier, ticketTierRequirement);
    const requiresRefund = current.status === 'expired' || guest.status === 'declined' || current.reservationExpiresAt <= paymentOccurredAt || !membershipEligible;
    const updated = await tx.partyCheckout.updateMany({
      where: { id: current.id, status: { in: ['creating', 'pending', 'expired'] } },
      data: { stripeSessionId: session.id, status: requiresRefund ? 'refund-required' : 'completed', completedAt: paymentOccurredAt },
    });
    if (updated.count !== 1) throw new Error('Party Checkout completion could not be recorded.');
    if (requiresRefund) {
      await tx.partyGuest.update({ where: { id: guest.id }, data: { status: 'refund-required', accessGranted: false } });
      return;
    }
    await tx.partyGuest.update({ where: { id: guest.id }, data: { status: 'ticketed', accessGranted: true, ticketTierName: current.ticketTierName } });
  });
}

partyStripeWebhookRouter.post('/webhooks/stripe/party', raw({ type: 'application/json' }), async (req, res) => {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    res.status(503).json({ error: 'Party payment confirmation is unavailable.' });
    return;
  }

  const signature = req.header('stripe-signature');
  if (!signature || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'Missing Stripe signature.' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = new Stripe(config.stripeSecretKey).webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch {
    res.status(400).json({ error: 'Invalid Stripe signature.' });
    return;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const checkoutId = metadataValue(session.metadata, 'checkoutId');
  const partyId = metadataValue(session.metadata, 'partyId');
  const userId = metadataValue(session.metadata, 'userId');
  const isPartyCheckout = metadataValue(session.metadata, 'kind') === 'party-ticket';
  if (!isPartyCheckout) {
    res.json({ received: true });
    return;
  }
  if (!checkoutId || !partyId || !userId) {
    res.status(400).json({ error: 'Incomplete Party Checkout metadata.' });
    return;
  }

  if (event.type === 'checkout.session.expired') {
    await db.partyCheckout.updateMany({
      where: { id: checkoutId, partyId, userId, status: { in: ['creating', 'pending'] } },
      data: { status: 'expired' },
    });
    res.json({ received: true });
    return;
  }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    res.json({ received: true });
    return;
  }
  if (session.mode !== 'payment' || session.payment_status !== 'paid') {
    res.json({ received: true });
    return;
  }

  try {
    await reconcilePartyCheckoutPayment(session, checkoutId, partyId, userId, new Date(event.created * 1000));
    res.json({ received: true });
  } catch (error) {
    if (error instanceof PartyCheckoutValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('[party-stripe-webhook] payment confirmation failed', error);
    res.status(500).json({ error: 'Party payment confirmation will be retried.' });
  }
});

export default partyStripeWebhookRouter;