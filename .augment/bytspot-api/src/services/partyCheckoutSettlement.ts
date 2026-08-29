import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { refundPartyCheckout } from './partyRefunds';
import { reconcilePartyCheckoutPayment } from '../routes/partyStripeWebhook';

/**
 * A Checkout Session Stripe has confirmed can never be paid. Set only after
 * asking Stripe, so it is the one pre-payment state that is safe to delete.
 */
export const ABANDONED = 'abandoned';

/**
 * Statuses from which a paid webhook can still arrive. `expired` is included
 * deliberately: it is our own hold timing out, not Stripe's, and the webhook
 * explicitly reconciles payments that land afterwards.
 */
const PAYABLE_STATUSES = ['creating', 'pending', 'expired'];

/**
 * Checkouts that still carry an obligation — money taken, money owed back, or
 * money that may yet arrive. The row is the only local pointer to the Stripe
 * charge, so anything matching this must survive until it is settled.
 */
export function unsettledCheckoutAt(now: Date = new Date()) {
  return {
    OR: [
      { status: 'completed' },
      { status: 'refund-required', refundedAt: null },
      { status: { in: PAYABLE_STATUSES }, stripeSessionId: { not: null }, refundedAt: null },
      // A reservation with no session recorded is not proof that no session
      // exists: Stripe creates the session before the row can be updated, so a
      // crash in that window leaves a payable session nobody knows about. While
      // the reservation is still live, treat it as money that may yet arrive.
      { status: { in: PAYABLE_STATUSES }, stripeSessionId: null, refundedAt: null, reservationExpiresAt: { gt: now } },
    ],
  };
}

/** Money actually owed to someone, as opposed to a sale that completed cleanly. */
export function owedCheckoutAt(now: Date = new Date()) {
  return {
    OR: [
      { status: 'refund-required', refundedAt: null },
      { status: { in: PAYABLE_STATUSES }, stripeSessionId: { not: null }, refundedAt: null },
      { status: { in: PAYABLE_STATUSES }, stripeSessionId: null, refundedAt: null, reservationExpiresAt: { gt: now } },
    ],
  };
}

/**
 * Sales that took money and have not returned it. Distinct from owedCheckout,
 * which deliberately excludes clean completed sales: when a host is leaving,
 * a completed sale is exactly the obligation, because the event it paid for is
 * about to stop existing.
 */
export const unrefundedSale = {
  status: { in: ['completed', 'refund-required'] },
  refundedAt: null,
};

type SettlementStripe = { checkout: { sessions: { retrieve: (id: string) => Promise<Stripe.Checkout.Session> } } };

/**
 * How many sessions one deletion attempt will settle. A party can hold
 * thousands of checkouts, and settling them all inline would hang the request
 * and hammer Stripe. Anything left over keeps blocking, so the host simply
 * retries rather than deleting something unsettled.
 */
const SETTLEMENT_BATCH = 50;

/**
 * Ask Stripe about every checkout that might still be holding money, so a
 * host is not blocked forever by a guest who opened a checkout and walked
 * away. A session Stripe reports as paid is reconciled (granting the pass or
 * marking the refund owed) and therefore stays undeletable; one Stripe
 * reports as expired and unpaid can never be paid, and is marked abandoned.
 *
 * Anything we cannot resolve is left exactly as it is, so the deletion guard
 * refuses: a host waiting is recoverable, a guest paying into a party whose
 * ledger we deleted is not.
 */
export async function settlePartyCheckoutsForDeletion(partyId: string, stripe?: SettlementStripe): Promise<void> {
  const pending = await db.partyCheckout.findMany({
    where: { partyId, status: { in: PAYABLE_STATUSES }, stripeSessionId: { not: null }, refundedAt: null },
    select: { id: true, userId: true, stripeSessionId: true },
    take: SETTLEMENT_BATCH,
  });
  if (pending.length === 0) return;

  const client = stripe ?? (config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null);
  if (!client) return;

  for (const checkout of pending) {
    try {
      const session = await client.checkout.sessions.retrieve(checkout.stripeSessionId as string);
      if (session.payment_status === 'paid') {
        const paidAt = new Date((session.created ?? Math.floor(Date.now() / 1000)) * 1000);
        if (checkout.userId) {
          await reconcilePartyCheckoutPayment(session, checkout.id, partyId, checkout.userId, paidAt);
        } else {
          // The buyer's account is gone, so no pass can be granted. The money
          // is owed back, and the ledger is what makes that recoverable.
          await db.partyCheckout.updateMany({
            where: { id: checkout.id, refundedAt: null },
            data: { status: 'refund-required', completedAt: paidAt },
          });
          await refundPartyCheckout(checkout.id);
        }
      } else if (session.status === 'expired' && session.payment_status === 'unpaid') {
        await db.partyCheckout.updateMany({
          where: { id: checkout.id, status: { in: PAYABLE_STATUSES }, refundedAt: null },
          data: { status: ABANDONED },
        });
      }
    } catch (err) {
      // Leave the row unsettled; the deletion guard is what fails closed. The
      // host sees a refused delete, so this must be visible to an operator.
      console.error('[party-checkout-settlement] could not settle checkout', { checkoutId: checkout.id, partyId });
      captureError(err, { job: 'party-checkout-settlement', checkoutId: checkout.id });
    }
  }
}

/**
 * A host leaving must not strand the people who bought tickets. Before their
 * account is purged, every party they host is settled: sessions that could
 * still take money are resolved, every charge that has not been refunded is
 * refunded, the passes it paid for are voided, and the party is cancelled.
 *
 * Returns false if anything could not be settled, which holds the purge. The
 * ledger survives the purge either way, so this is about not silently keeping
 * a guest's money for an event that will never happen.
 */
export async function refundHostedPartiesForPurge(hostUserId: string): Promise<{ settled: boolean }> {
  const parties = await db.party.findMany({ where: { hostUserId }, select: { id: true } });
  let settled = true;

  for (const party of parties) {
    await settlePartyCheckoutsForDeletion(party.id);

    const charged = await db.partyCheckout.findMany({
      where: { partyId: party.id, status: { in: ['completed', 'refund-required'] }, refundedAt: null },
      select: { id: true, partyGuestId: true },
      take: SETTLEMENT_BATCH,
    });
    for (const checkout of charged) {
      const outcome = await refundPartyCheckout(checkout.id);
      if (outcome === 'failed') {
        settled = false;
        continue;
      }
      if (outcome === 'nothing-to-refund') {
        // Marked as a sale but with no charge behind it, so there is nothing to
        // return. Retired explicitly, because leaving it unrefunded would block
        // this host's purge on an obligation that does not exist.
        await db.partyCheckout.updateMany({ where: { id: checkout.id, refundedAt: null }, data: { status: ABANDONED } });
        continue;
      }
      await db.partyCheckout.updateMany({
        where: { id: checkout.id, status: 'completed' },
        data: { status: 'refund-required' },
      });
      if (checkout.partyGuestId) {
        await db.partyGuest.updateMany({
          where: { id: checkout.partyGuestId },
          data: { status: 'refund-required', accessGranted: false },
        });
      }
    }

    // Anything still unsettled leaves the party as it is so the next run tries
    // again. This has to include completed sales: the batch above is capped, so
    // a party with more sales than one run can refund must not be treated as
    // settled. Each run refunds a batch and shrinks the set, so runs progress.
    const unresolved = await db.partyCheckout.findFirst({
      where: { partyId: party.id, OR: [owedCheckoutAt(), unrefundedSale] },
      select: { id: true },
    });
    if (unresolved) {
      settled = false;
      continue;
    }
    await db.party.updateMany({ where: { id: party.id, status: 'published' }, data: { status: 'cancelled' } });
  }

  return { settled };
}

/**
 * Erasure detaches a checkout from its party, its guest row and its buyer, so
 * every party-scoped settlement path stops being able to see it. A ledger that
 * survives but cannot be found is not much better than one that was deleted,
 * so this sweeps detached rows that still owe money and refunds them directly.
 *
 * Rows with no Stripe pointer at all cannot be refunded from here and are
 * reported for review rather than quietly skipped.
 */
export async function sweepDetachedCheckouts(limit = SETTLEMENT_BATCH): Promise<{ refunded: number; failed: number; needsReview: number }> {
  const detached = await db.partyCheckout.findMany({
    where: { partyId: null, ...unrefundedSale },
    select: { id: true, stripePaymentIntentId: true, stripeSessionId: true },
    take: limit,
  });

  let refunded = 0;
  let failed = 0;
  let needsReview = 0;
  for (const checkout of detached) {
    if (!checkout.stripePaymentIntentId && !checkout.stripeSessionId) {
      // Money may have moved with no local pointer to reverse it. This needs a
      // human against Stripe's own records; retrying here would never resolve.
      console.error('[detached-ledger] unrefundable row with no Stripe pointer', { checkoutId: checkout.id });
      captureError(new Error('Detached Party Checkout has no Stripe pointer to refund'), { checkoutId: checkout.id, scope: 'detached-ledger' });
      needsReview += 1;
      continue;
    }
    const outcome = await refundPartyCheckout(checkout.id);
    if (outcome === 'refunded' || outcome === 'already-refunded') {
      refunded += 1;
    } else if (outcome === 'nothing-to-refund') {
      await db.partyCheckout.updateMany({ where: { id: checkout.id, refundedAt: null }, data: { status: ABANDONED } });
    } else {
      failed += 1;
    }
  }

  return { refunded, failed, needsReview };
}
