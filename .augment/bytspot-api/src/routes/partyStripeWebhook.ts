import { raw, Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';

const partyStripeWebhookRouter = Router();

function metadataValue(metadata: Stripe.Metadata | null, key: string): string | null {
  const value = metadata?.[key]?.trim();
  return value || null;
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
    const checkout = await db.partyCheckout.findUnique({ where: { id: checkoutId } });
    if (!checkout) {
      res.status(500).json({ error: 'Party Checkout reservation was not found.' });
      return;
    }
    const expectedTier = metadataValue(session.metadata, 'ticketTierName');
    if (checkout.partyId !== partyId || checkout.userId !== userId || checkout.ticketTierName !== expectedTier || checkout.amountCents !== session.amount_total || checkout.currency !== session.currency?.toLowerCase()) {
      res.status(400).json({ error: 'Party Checkout values did not match the reservation.' });
      return;
    }

    await db.$transaction(async (tx) => {
      const current = await tx.partyCheckout.findUnique({ where: { id: checkout.id } });
      if (!current || current.status === 'completed') return;
      if (current.status === 'expired' || current.reservationExpiresAt <= new Date()) throw new Error('Party Checkout reservation expired before payment confirmation.');
      if (current.stripeSessionId && current.stripeSessionId !== session.id) throw new Error('Party Checkout session mismatch.');
      const updated = await tx.partyCheckout.updateMany({
        where: { id: current.id, status: { in: ['creating', 'pending'] } },
        data: { stripeSessionId: session.id, status: 'completed', completedAt: new Date() },
      });
      if (updated.count !== 1) throw new Error('Party Checkout completion could not be recorded.');
      const guest = await tx.partyGuest.findUnique({ where: { id: current.partyGuestId } });
      if (!guest || guest.status === 'declined') throw new Error('Party guest is not eligible for payment confirmation.');
      await tx.partyGuest.update({ where: { id: guest.id }, data: { status: 'ticketed', accessGranted: true, ticketTierName: current.ticketTierName } });
    });
    res.json({ received: true });
  } catch (error) {
    console.error('[party-stripe-webhook] payment confirmation failed', error);
    res.status(500).json({ error: 'Party payment confirmation will be retried.' });
  }
});

export default partyStripeWebhookRouter;