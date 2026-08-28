import { raw, Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { meetsRequiredMembershipTier } from '../lib/membershipTier';
import { alertHostOfCircleTicketPurchase, dispatchPartyAlert } from '../services/partyAlerts';
import { applySubscriptionEvent } from '../services/subscriptionEntitlement';
import { applyAccountUpdate } from '../services/hostPayouts';
import { refundPartyCheckout } from '../services/partyRefunds';

const partyStripeWebhookRouter = Router();

function metadataValue(metadata: Stripe.Metadata | null, key: string): string | null {
  const value = metadata?.[key]?.trim();
  return value || null;
}

type PartyCheckoutMetadata =
  | { checkoutId: string; partyId: string; userId: string; kind: string | null; hasPartyIdentifiers: true }
  | { checkoutId: string | null; partyId: string | null; userId: string | null; kind: string | null; hasPartyIdentifiers: false };

export function partyCheckoutMetadata(session: Pick<Stripe.Checkout.Session, 'metadata'>): PartyCheckoutMetadata {
  const checkoutId = metadataValue(session.metadata, 'checkoutId');
  const partyId = metadataValue(session.metadata, 'partyId');
  const userId = metadataValue(session.metadata, 'userId');
  const kind = metadataValue(session.metadata, 'kind');
  if (checkoutId && partyId && userId) {
    return { checkoutId, partyId, userId, kind, hasPartyIdentifiers: true };
  }
  return {
    checkoutId,
    partyId,
    userId,
    kind,
    hasPartyIdentifiers: false,
  };
}

function logIgnoredEvent(event: Stripe.Event, session: Stripe.Checkout.Session, metadata: ReturnType<typeof partyCheckoutMetadata>) {
  console.info('[party-stripe-webhook] ignored signed event', {
    eventType: event.type,
    hasPartyIdentifiers: metadata.hasPartyIdentifiers,
    hasPartyKind: metadata.kind === 'party-ticket',
    mode: session.mode ?? null,
    paymentStatus: session.payment_status ?? null,
  });
}

export class PartyCheckoutValidationError extends Error {}

function ticketRequiredMembershipTier(ticketTiers: unknown, ticketTierName: string): unknown {
  if (!Array.isArray(ticketTiers)) return null;
  return ticketTiers.find((tier): tier is { name: unknown; requiredMembershipTier: unknown } => Boolean(tier) && typeof tier === 'object' && 'name' in tier && 'requiredMembershipTier' in tier && (tier as { name: unknown }).name === ticketTierName)?.requiredMembershipTier ?? null;
}

export async function reconcilePartyCheckoutPayment(session: Stripe.Checkout.Session, checkoutId: string, partyId: string, userId: string, paymentOccurredAt: Date): Promise<void> {
  let refundNeeded = false;
  const checkout = await db.partyCheckout.findUnique({ where: { id: checkoutId } });
  if (!checkout) throw new Error('Party Checkout reservation was not found.');
  const expectedTier = metadataValue(session.metadata, 'ticketTierName');
  if (checkout.partyId !== partyId || checkout.userId !== userId || checkout.ticketTierName !== expectedTier || checkout.amountCents !== session.amount_total || checkout.currency !== session.currency?.toLowerCase()) {
    throw new PartyCheckoutValidationError('Party Checkout values did not match the reservation.');
  }

  const granted = await db.$transaction(async (tx) => {
    const current = await tx.partyCheckout.findUnique({ where: { id: checkout.id } });
    if (!current || current.status === 'completed' || current.status === 'refund-required') return false;
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
      refundNeeded = true;
      return false;
    }
    await tx.partyGuest.update({ where: { id: guest.id }, data: { status: 'ticketed', accessGranted: true, ticketTierName: current.ticketTierName } });
    return true;
  });

  // The guest paid for a pass they did not get, so the money goes back rather
  // than sitting behind a status only staff can see. Outside the transaction:
  // a Stripe call must not be able to roll back the record of the charge.
  if (refundNeeded) {
    await refundPartyCheckout(checkoutId);
  }

  // Courtesy signal to the host, after the money and the pass are both settled.
  // Never inside the transaction: a push must not be able to roll back a ticket.
  if (granted) {
    dispatchPartyAlert(alertHostOfCircleTicketPurchase({ partyId, buyerUserId: userId }));
  }
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

  // Subscription transitions share this endpoint because it is the one place a
  // Stripe signature is verified. They are claimed before the Party cast, which
  // does not hold for subscription objects.
  try {
    if (await applySubscriptionEvent(event)) {
      res.json({ received: true });
      return;
    }
  } catch (error) {
    console.error('[subscription-webhook] membership transition failed', error);
    res.status(500).json({ error: 'Membership transition will be retried.' });
    return;
  }

  // Connect account transitions are claimed before the Party cast for the same
  // reason as subscriptions: the object is not a Checkout Session. Keeping the
  // mirror current is what lets a host see an accurate payout status; the sale
  // gates re-read Stripe regardless, so a missed delivery cannot open a sale.
  if (event.type === 'account.updated') {
    await applyAccountUpdate(event.data.object as Stripe.Account);
    res.json({ received: true });
    return;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const metadata = partyCheckoutMetadata(session);
  if (!metadata.hasPartyIdentifiers) {
    if (metadata.kind === 'party-ticket') {
      res.status(400).json({ error: 'Incomplete Party Checkout metadata.' });
      return;
    }
    logIgnoredEvent(event, session, metadata);
    res.json({ received: true });
    return;
  }
  if (metadata.kind !== 'party-ticket') {
    console.warn('[party-stripe-webhook] reconciling Party checkout without expected kind marker', {
      eventType: event.type,
      mode: session.mode ?? null,
      paymentStatus: session.payment_status ?? null,
    });
  }
  const { checkoutId, partyId, userId } = metadata;

  if (event.type === 'checkout.session.expired') {
    await db.partyCheckout.updateMany({
      where: { id: checkoutId, partyId, userId, status: { in: ['creating', 'pending'] } },
      data: { status: 'expired' },
    });
    res.json({ received: true });
    return;
  }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    logIgnoredEvent(event, session, metadata);
    res.json({ received: true });
    return;
  }
  if (session.mode !== 'payment' || session.payment_status !== 'paid') {
    logIgnoredEvent(event, session, metadata);
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