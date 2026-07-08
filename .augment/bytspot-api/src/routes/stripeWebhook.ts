import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { config } from '../config';
import { handleStripeWebhookEvent } from '../trpc/router';

const router = Router();
const stripeWebhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Stripe webhook requests' },
});

router.post('/stripe/webhook', stripeWebhookLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    res.status(503).json({ error: 'Stripe webhook not configured' });
    return;
  }

  const signature = req.header('stripe-signature');
  if (!signature) {
    res.status(400).json({ error: 'Missing Stripe signature' });
    return;
  }

  const stripe = new Stripe(config.stripeSecretKey);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid Stripe webhook signature';
    res.status(400).json({ error: message });
    return;
  }

  try {
    const result = await handleStripeWebhookEvent(event);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Stripe webhook processing failed';
    console.error('[stripe-webhook] Processing failed:', message);
    res.status(500).json({ error: 'Stripe webhook processing failed' });
  }
});

export default router;
