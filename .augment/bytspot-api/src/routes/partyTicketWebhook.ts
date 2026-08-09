import { createHash, randomBytes } from 'crypto';
import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';

const router = Router();

function passHash(): string {
  return createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex');
}

async function fulfillTicket(session: Stripe.Checkout.Session) {
  if (session.payment_status !== 'paid') return;
  await db.$transaction(async (tx) => {
    const guest = await tx.partyGuest.findUnique({ where: { stripeCheckoutSessionId: session.id } });
    if (!guest || guest.status !== 'pending-payment') return;
    await tx.$queryRaw`SELECT "id" FROM "parties" WHERE "id" = ${guest.partyId} FOR UPDATE`;
    await tx.partyGuest.update({
      where: { id: guest.id },
      data: { status: 'confirmed', attendeePassHash: passHash(), attendeePassIssuedAt: new Date() },
    });
  });
}

router.post('/party-ticket', async (req, res) => {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    res.status(503).json({ error: 'Party ticket payments are not configured.' });
    return;
  }
  const signature = req.header('stripe-signature');
  if (!signature || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'Missing Stripe signature or raw request body.' });
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
  if (session.metadata?.purchaseType !== 'party-ticket') {
    res.json({ received: true });
    return;
  }
  try {
    if (event.type === 'checkout.session.completed') await fulfillTicket(session);
    if (event.type === 'checkout.session.expired') {
      await db.partyGuest.updateMany({ where: { stripeCheckoutSessionId: session.id, status: 'pending-payment' }, data: { status: 'expired' } });
    }
    res.json({ received: true });
  } catch (error) {
    console.error('[party-ticket-webhook] fulfillment failed', error instanceof Error ? error.message : 'unknown error');
    res.status(500).json({ error: 'Ticket fulfillment failed.' });
  }
});

export default router;