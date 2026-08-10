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

  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    res.json({ received: true });
    return;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const partyId = metadataValue(session.metadata, 'partyId');
  const userId = metadataValue(session.metadata, 'userId');
  if (session.mode !== 'payment' || session.payment_status !== 'paid' || metadataValue(session.metadata, 'kind') !== 'party-ticket' || !partyId || !userId) {
    res.json({ received: true });
    return;
  }

  await db.partyGuest.updateMany({
    where: { partyId, userId, stripeSessionId: session.id, status: 'checkout-pending' },
    data: { status: 'ticketed', accessGranted: true },
  });
  res.json({ received: true });
});

export default partyStripeWebhookRouter;