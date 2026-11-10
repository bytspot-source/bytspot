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
 * restores access by hand after checking. Winning does clear disputedAt so
 * the host payout can resume (REA X2 re-review). Open or lost disputes stay
 * frozen.
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
    // Still record the event so it is not silently dropped (Stripe will not
    // retry a 200). There is no checkout to attach it to.
    console.warn('[stripe-risk] event without a payment intent', { type: event.type, id: event.id });
    await db.$transaction(async (tx) => {
      try {
        await tx.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
        throw error;
      }
    });
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
      const won = dispute.status === 'won';
      // Any open or lost dispute revokes; a won one leaves access as it is
      // (an admin restores it, not this handler) and clears the payout freeze.
      const revoke = won ? false : event.type === 'charge.dispute.closed' ? dispute.status === 'lost' : true;
      for (const checkout of checkouts) {
        await tx.partyCheckout.update({
          where: { id: checkout.id },
          data: won
            ? { disputedAt: null, disputeStatus: 'won' }
            : { disputedAt: now, disputeStatus: dispute.status ?? null },
        });
        if (revoke) await revokePartyAccess(tx, checkout, 'disputed');
      }
      if (won) {
        await tx.vendorTicketOrder.updateMany({
          where: { id: { in: orders.map((o) => o.id) }, status: 'disputed' },
          data: { status: 'completed' },
        });
      } else if (revoke) {
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

/** Page size for refundParty. Overridable in tests so pagination is exercised without thousands of rows. */
export const REFUND_PARTY_PAGE_SIZE = 200;

/**
 * Close refunds paid guests when the night was not delivered: no one has
 * checked in, and the party has not yet ended. After a check-in or after
 * endsAt, close only hides the room (the host must cancel to refund). The
 * decision is evaluated at `asOf` (first close: now; a retry: closedAt) so a
 * later retry does not change the original choice.
 */
export function closeShouldRefund(
  party: { endsAt: Date | null },
  checkedInCount: number,
  asOf = new Date(),
): boolean {
  if (checkedInCount > 0) return false;
  // No end time: treat the night as not yet delivered and refund.
  if (!party.endsAt) return true;
  return party.endsAt.getTime() > asOf.getTime();
}

/** Refunds every paid checkout of a party. Used on cancel, close-before-delivery, and moderation removal. */
export async function refundParty(
  partyId: string,
  reason: string,
  stripe: Stripe | null = stripeHandle.client(),
  options: { pageSize?: number } = {},
): Promise<PartyRefundResult> {
  const result: PartyRefundResult = { refunded: 0, skipped: 0, failed: 0 };
  const pageSize = options.pageSize ?? REFUND_PARTY_PAGE_SIZE;
  const ids: string[] = [];
  let cursor: string | undefined;
  // Collect first, then refund, so pagination does not walk a list we are
  // mutating (a refunded row leaves the status filter).
  for (;;) {
    const rows = await db.partyCheckout.findMany({
      where: { partyId, status: { in: ['completed', 'refund-required'] } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    ids.push(...rows.map((row) => row.id));
    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1].id;
  }
  for (const id of ids) result[await refundPartyCheckout(id, reason, stripe)]++;
  if (result.failed > 0) console.error('[party-refund] some refunds failed and will need a retry', { partyId, ...result });
  return result;
}
