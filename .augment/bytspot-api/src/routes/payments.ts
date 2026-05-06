import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { optionalAuth } from '../middleware/auth';

const router = Router();

/**
 * POST /payments/checkout
 * Creates a Stripe Checkout session for a parking reservation.
 * Returns { url } — the hosted Stripe payment page.
 *
 * Body: { spotName, address, duration, totalCost, spotId }
 */
router.post('/payments/checkout', optionalAuth, async (req, res) => {
  if (!config.stripeSecretKey) {
    // Stripe not configured — return a demo mode response so the UI still works
    res.json({
      url: null,
      demoMode: true,
      message: 'Stripe not configured — set STRIPE_SECRET_KEY env var on Render',
    });
    return;
  }

  const stripe = new Stripe(config.stripeSecretKey);
  const { spotName, address, duration, totalCost, spotId } = req.body as {
    spotName: string;
    address: string;
    duration: number;
    totalCost: number;
    spotId: string;
  };
  const amountCents = Math.round(totalCost * 100);

  if (!spotName || !totalCost) {
    res.status(400).json({ error: 'spotName and totalCost are required' });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amountCents, // Stripe uses cents
            product_data: {
              name: `Parking — ${spotName}`,
              description: `${duration}h at ${address}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        flow: 'parking.checkout',
        source: 'parking.checkout',
        spotId: spotId || '',
        duration: String(duration),
        amountCents: String(amountCents),
        ...(req.user?.userId ? { userId: req.user.userId } : {}),
      },
      success_url: `${config.frontendUrl}/parking/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.frontendUrl}/parking/cancelled`,
    });

    res.json({ url: session.url });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Stripe error';
    console.error('[payments] Stripe error:', msg);
    res.status(500).json({ error: msg });
  }
});

export default router;

