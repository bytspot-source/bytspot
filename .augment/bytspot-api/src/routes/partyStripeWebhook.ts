import { raw, Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { meetsRequiredMembershipTier } from '../lib/membershipTier';
import { alertHostOfCircleTicketPurchase, dispatchPartyAlert } from '../services/partyAlerts';
import { applySubscriptionEvent } from '../services/subscriptionEntitlement';

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

// Null when the checkout bought no gate ticket, which requires nothing of the
// guest's tier on the gate's behalf.
function ticketRequiredMembershipTier(ticketTiers: unknown, ticketTierName: string | null): unknown {
  if (!ticketTierName || !Array.isArray(ticketTiers)) return null;
  return ticketTiers.find((tier): tier is { name: unknown; requiredMembershipTier: unknown } => Boolean(tier) && typeof tier === 'object' && 'name' in tier && 'requiredMembershipTier' in tier && (tier as { name: unknown }).name === ticketTierName)?.requiredMembershipTier ?? null;
}

export async function reconcilePartyCheckoutPayment(session: Stripe.Checkout.Session, checkoutId: string, partyId: string, userId: string, paymentOccurredAt: Date): Promise<void> {
  const checkout = await db.partyCheckout.findUnique({ where: { id: checkoutId } });
  if (!checkout) throw new Error('Party Checkout reservation was not found.');
  const expectedTier = metadataValue(session.metadata, 'ticketTierName');
  const expectedSession = metadataValue(session.metadata, 'sessionId');
  // Absent metadata means the charge did not include that half at all, which
  // is how a session-only or gate-only checkout states itself. Both sides
  // normalise to null so a missing key and an empty one agree.
  if (checkout.partyId !== partyId || checkout.userId !== userId
    || (checkout.ticketTierName || null) !== expectedTier || (checkout.sessionId || null) !== expectedSession
    || checkout.amountCents !== session.amount_total || checkout.currency !== session.currency?.toLowerCase()) {
    throw new PartyCheckoutValidationError('Party Checkout values did not match the reservation.');
  }

  const granted = await db.$transaction(async (tx) => {
    const current = await tx.partyCheckout.findUnique({ where: { id: checkout.id } });
    if (!current || current.status === 'completed' || current.status === 'refund-required') return false;
    if (current.stripeSessionId && current.stripeSessionId !== session.id) throw new Error('Party Checkout session mismatch.');
    const [guest, party, user, boughtSession] = await Promise.all([
      tx.partyGuest.findUnique({ where: { id: current.partyGuestId } }),
      tx.party.findUnique({ where: { id: current.partyId }, select: { requiredMembershipTier: true, ticketTiers: true, closedAt: true } }),
      tx.user.findUnique({ where: { id: current.userId }, select: { membershipTier: true } }),
      // Re-read rather than trusted from checkout time: the ticket tier is
      // re-checked here and a session gates on its own terms too.
      current.sessionId
        ? tx.partySession.findUnique({ where: { id: current.sessionId }, select: { requiredMembershipTier: true } })
        : null,
    ]);
    const sessionRequirement = boughtSession?.requiredMembershipTier ?? null;
    if (!guest) throw new Error('Party guest is not eligible for payment confirmation.');
    const ticketTierRequirement = ticketRequiredMembershipTier(party?.ticketTiers, current.ticketTierName);
    // `meetsRequiredMembershipTier` answers false when there is no
    // requirement, because it demands two real tiers. Asking it about an
    // absent one therefore reads "not met" and refunds a payment nobody
    // objected to: a session carries no tier of its own, and neither does a
    // ticket tier that never named one. A stated requirement is enforced; an
    // absent one is not a failed one. The Party's own tier is not optional —
    // the column is NOT NULL, so a missing one is broken data, not an
    // absence.
    const membershipEligible = meetsRequiredMembershipTier(user?.membershipTier, party?.requiredMembershipTier)
      && (ticketTierRequirement == null || meetsRequiredMembershipTier(user?.membershipTier, ticketTierRequirement))
      && (sessionRequirement == null || meetsRequiredMembershipTier(user?.membershipTier, sessionRequirement));
    // A delayed webhook for a payment that happened before close still grants
    // the pass. A payment that completed after closedAt is a new arrival and
    // must not confirm — the host closed the room.
    // Stripe event.created is second-granularity; closedAt is milliseconds.
    // Same-second payments cannot be ordered, so they refund: a close at
    // 12:00:00.700 and a checkout at 12:00:00.800 would otherwise look like
    // the payment happened first.
    const paidAfterClose = Boolean(
      party?.closedAt
      && Math.floor(paymentOccurredAt.getTime() / 1000) >= Math.floor(party.closedAt.getTime() / 1000),
    );
    const requiresRefund = current.status === 'expired' || guest.status === 'declined' || current.reservationExpiresAt <= paymentOccurredAt || !membershipEligible || paidAfterClose;
    const updated = await tx.partyCheckout.updateMany({
      where: { id: current.id, status: { in: ['creating', 'pending', 'expired'] } },
      data: { stripeSessionId: session.id, status: requiresRefund ? 'refund-required' : 'completed', completedAt: paymentOccurredAt },
    });
    if (updated.count !== 1) throw new Error('Party Checkout completion could not be recorded.');
    if (requiresRefund) {
      // Only a gate purchase may mark the admission row for refund. A session
      // that has to be refunded is refunded on its own; taking the pass down
      // with it would eject a guest whose door was paid separately and is
      // not in question.
      if (current.ticketTierName) {
        await tx.partyGuest.update({ where: { id: guest.id }, data: { status: 'refund-required', accessGranted: false } });
      }
      return false;
    }
    // Taking the unit is guarded, so a session that filled while this payment
    // was in flight refunds instead of overselling. The database refuses the
    // oversell either way; this is the half that can still say why.
    if (current.sessionId) {
      const taken = await tx.partySession.updateMany({
        where: { id: current.sessionId, committed: { lt: tx.partySession.fields.quantity } },
        data: { committed: { increment: 1 } },
      });
      if (taken.count !== 1) {
        await tx.partyCheckout.update({ where: { id: current.id }, data: { status: 'refund-required' } });
        // A failed session purchase refunds the session. It does not touch
        // admission, because the guest may have paid the door separately and
        // be standing in the room already.
        if (current.ticketTierName) {
          await tx.partyGuest.update({ where: { id: guest.id }, data: { status: 'refund-required', accessGranted: false } });
        }
        return false;
      }
      // The claim is the guest's hold on the session, kept off the admission
      // row so buying bottles cannot rewrite a pass.
      await tx.partySessionClaim.create({
        data: { sessionId: current.sessionId, partyId, userId, state: 'held' },
      });
    }
    // Only a gate ticket grants admission. A guest who bought bottles from a
    // promoter while already inside keeps the access they arrived with, and a
    // guest who bought only bottles does not silently acquire a door they
    // never paid for.
    if (current.ticketTierName) {
      await tx.partyGuest.update({
        where: { id: guest.id },
        data: { status: 'ticketed', accessGranted: true, ticketTierName: current.ticketTierName },
      });
    }
    return true;
  });

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