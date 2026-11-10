import type Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { stripeHandle } from '../vendor/payout';

/**
 * REA review 2026-11-10, X2. Disputes, refunds and early fraud warnings, and
 * automatic refunds when a party is cancelled or removed by moderation.
 *
 * Bytspot is the merchant of record, so every chargeback lands on its
 * balance. When Stripe says a charge is disputed, refunded or likely fraud:
 *   - the guest's pass stops working (party guest access revoked, vendor
 *     ticket order taken off the door),
 *   - the checkout is flagged so the payout run never transfers it (the
 *     existing payout reversal already claws back a transfer that went out),
 *   - the event id is recorded, so redelivery is a no-op.
 * A dispute that is later won does not silently re-admit anyone; an admin
 * restores access by hand after checking.
 */
export const RISK_EVENT_TYPES = new Set([
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.refunded',
  'radar.early_fraud_warning.created',
  'radar.early_fraud_warning.updated',
]);

type Tx = Prisma.TransactionClient;
const idOf = (value: string | { id: string } | null | undefined) => (typeof value === 'string' ? value : value?.id ?? null);

function paymentIntentOf(event: Stripe.Event): string | null {
  const object = event.data.object as { payment_intent?: string | { id: string } | null };
  return idOf(object.payment_intent ?? null);
}

/**
 * Revokes what a checkout bought and keeps the rows and their history. A gate
 * ticket takes the pass down; a table only releases the table, because the
 * guest may have paid the door separately.
 */
async function revokePartyAccess(tx: Tx, checkout: { partyGuestId: string; ticketTierName: string | null; sessionId: string | null; partyId: string; userId: string }, status: string) {
  if (checkout.ticketTierName) {
    await tx.partyGuest.updateMany({
      where: { id: checkout.partyGuestId },
      data: { accessGranted: false, status, credential: null },
    });
  } else {
    await tx.partyGuest.updateMany({ where: { id: checkout.partyGuestId, status: 'refund-required' }, data: { status } });
  }
  if (checkout.sessionId) {
    const released = await tx.partySessionClaim.updateMany({
      where: { sessionId: checkout.sessionId, partyId: checkout.partyId, userId: checkout.userId, state: 'held' },
      data: { state: 'released' },
    });
    if (released.count > 0) {
      await tx.partySession.updateMany({
        where: { id: checkout.sessionId, committed: { gte: released.count } },
        data: { committed: { decrement: released.count } },
      });
    }
  }
}

/**
 * Applies one signed Stripe risk event. Returns false for events it does not
 * own, so the webhook can keep routing. Throws on a database failure so
 * Stripe retries; the event row and the changes commit together.
 */
export async function applyChargeRiskEvent(event: Stripe.Event, now = new Date()): Promise<boolean> {
  if (!RISK_EVENT_TYPES.has(event.type)) return false;
  const paymentIntentId = paymentIntentOf(event);
  if (!paymentIntentId) {
    console.warn('[stripe-risk] event without a payment intent', { type: event.type });
    return true;
  }
  await db.$transaction(async (tx) => {
    try {
      await tx.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return; // already applied
      throw error;
    }
    const checkouts = await tx.partyCheckout.findMany({
      where: { paymentIntentId },
      select: { id: true, partyId: true, partyGuestId: true, userId: true, ticketTierName: true, sessionId: true, status: true },
    });
    const orders = await tx.vendorTicketOrder.findMany({ where: { paymentIntentId }, select: { id: true, status: true } });

    if (event.type.startsWith('charge.dispute.')) {
      const dispute = event.data.object as Stripe.Dispute;
      // Any open dispute revokes; a closed one that Bytspot won leaves things as
      // they are (access is restored by an admin, not automatically).
      const revoke = event.type === 'charge.dispute.closed' ? dispute.status === 'lost' : true;
      for (const checkout of checkouts) {
        await tx.partyCheckout.update({
          where: { id: checkout.id },
          data: { disputedAt: now, disputeStatus: dispute.status ?? null },
        });
        if (revoke) await revokePartyAccess(tx, checkout, 'disputed');
      }
      if (revoke) {
        await tx.vendorTicketOrder.updateMany({ where: { id: { in: orders.map((o) => o.id) }, status: 'completed' }, data: { status: 'disputed' } });
      }
      return;
    }

    if (event.type.startsWith('radar.early_fraud_warning.')) {
      for (const checkout of checkouts) {
        await tx.partyCheckout.update({ where: { id: checkout.id }, data: { fraudWarningAt: now } });
        await revokePartyAccess(tx, checkout, 'fraud-review');
      }
      await tx.vendorTicketOrder.updateMany({ where: { id: { in: orders.map((o) => o.id) }, status: 'completed' }, data: { status: 'disputed' } });
      return;
    }

    // charge.refunded. Only a full refund ends the pass; a partial refund is a
    // goodwill credit the host or Bytspot chose and the guest keeps entry.
    const charge = event.data.object as Stripe.Charge;
    if (!charge.refunded) return;
    for (const checkout of checkouts) {
      if (checkout.status === 'refunded') continue;
      await tx.partyCheckout.update({
        where: { id: checkout.id },
        data: { status: 'refunded', refundedAt: now, refundReason: 'Refunded in Stripe' },
      });
      await revokePartyAccess(tx, checkout, 'refunded');
    }
    await tx.vendorTicketOrder.updateMany({
      where: { id: { in: orders.map((o) => o.id) }, status: { in: ['completed', 'settling', 'disputed'] } },
      data: { status: 'refunded', refundReason: 'Refunded in Stripe' },
    });
  });
  return true;
}

export interface PartyRefundResult { refunded: number; skipped: number; failed: number }

/**
 * Refunds one party checkout in full and revokes what it bought. Idempotent:
 * Stripe dedupes on the key, and a checkout already refunded is skipped.
 */
export async function refundPartyCheckout(
  checkoutId: string,
  reason: string,
  stripe: Stripe | null = stripeHandle.client(),
  options: { statuses?: string[]; now?: Date } = {},
): Promise<'refunded' | 'skipped' | 'failed'> {
  const statuses = options.statuses ?? ['completed', 'refund-required'];
  const now = options.now ?? new Date();
  const checkout = await db.partyCheckout.findUnique({
    where: { id: checkoutId },
    select: { id: true, partyId: true, partyGuestId: true, userId: true, ticketTierName: true, sessionId: true, status: true, paymentIntentId: true },
  });
  if (!checkout || !statuses.includes(checkout.status) || !checkout.paymentIntentId) return 'skipped';
  if (!stripe) return 'failed';
  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(
      { payment_intent: checkout.paymentIntentId, reason: 'requested_by_customer', metadata: { checkoutId: checkout.id, partyId: checkout.partyId, reason } },
      { idempotencyKey: `party-refund:${checkout.id}` },
    );
  } catch (error) {
    captureError(error, { flow: 'party-refund', checkoutId: checkout.id });
    return 'failed';
  }
  await db.$transaction(async (tx) => {
    const updated = await tx.partyCheckout.updateMany({
      where: { id: checkout.id, status: { in: statuses } },
      data: { status: 'refunded', refundId: refund.id, refundedAt: now, refundReason: reason },
    });
    if (updated.count === 1) await revokePartyAccess(tx, checkout, 'refunded');
  });
  return 'refunded';
}

/** Refunds every paid checkout of a party. Used on cancel and on moderation removal. */
export async function refundParty(partyId: string, reason: string, stripe: Stripe | null = stripeHandle.client()): Promise<PartyRefundResult> {
  const result: PartyRefundResult = { refunded: 0, skipped: 0, failed: 0 };
  const rows = await db.partyCheckout.findMany({
    where: { partyId, status: { in: ['completed', 'refund-required'] } },
    select: { id: true },
    take: 5000,
  });
  for (const row of rows) result[await refundPartyCheckout(row.id, reason, stripe)]++;
  if (result.failed > 0) console.error('[party-refund] some refunds failed and will need a retry', { partyId, ...result });
  return result;
}
