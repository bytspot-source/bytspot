import express from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { appRouter } from '../trpc/router';

const router = express.Router();

router.get('/stripe/webhook', (_req, res) => {
  res.status(200).json({ ok: true, endpoint: 'stripe-webhook' });
});

function webhookCaller() {
  return appRouter.createCaller({ user: null });
}

async function dispatchStripeEvent(event: Stripe.Event) {
  const caller = webhookCaller();

  if (event.type === 'account.updated') {
    return caller.vendors.connectWebhook({
      type: event.type,
      data: { object: event.data.object as any },
    });
  }

  return caller.subscription.webhook({
    type: event.type,
    data: { object: event.data.object as any },
  });
}

router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    res.status(503).json({ error: 'Stripe webhook is not configured' });
    return;
  }

  const signature = req.header('stripe-signature');
  if (!signature) {
    res.status(400).json({ error: 'Missing Stripe signature' });
    return;
  }

  let event: Stripe.Event;
  try {
    const stripe = new Stripe(config.stripeSecretKey);
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch (err: any) {
    res.status(400).json({ error: 'Invalid Stripe webhook signature', message: err?.message ?? 'Signature verification failed' });
    return;
  }

  try {
    const result = await dispatchStripeEvent(event);
    res.status(200).json({ received: true, type: event.type, result });
  } catch (err: any) {
    console.error('[stripe:webhook] handler failed', { type: event.type, message: err?.message });
    res.status(500).json({ error: 'Stripe webhook handler failed' });
  }
});

export default router;
