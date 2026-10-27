import type Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { refreshHostPayout } from './hostPayouts';

/**
 * Pays party sales out to the people they are owed to, after the party ends.
 *
 * Each sale already records its split at checkout: the host's ticket share
 * and, for a table sold by a business the host asked, that business's share.
 * This sends each share by Stripe transfer from the charge it was paid by,
 * once the party has been over for the payout delay. Bytspot's fee is what
 * stays behind.
 *
 * A recipient without a working Stripe account is skipped, not failed: the
 * sale stays owed and is paid on the first run after they finish onboarding.
 * A refunded or disputed charge is held for a person to decide.
 */

const DEFAULT_PARTY_LENGTH_MS = 6 * 60 * 60 * 1000;
const DETAIL_MAX = 200;

export type Recipient = 'host' | 'seller';

export interface PartyPayoutRunResult {
  paid: number;
  held: number;
  failed: number;
  waiting: number;
}

/** When a party is over: its end, or six hours after it starts, as the share link reads it. */
export function partyOverAt(party: { startsAt: Date; endsAt: Date | null }): Date {
  return party.endsAt ?? new Date(party.startsAt.getTime() + DEFAULT_PARTY_LENGTH_MS);
}

export function payoutDueAt(party: { startsAt: Date; endsAt: Date | null }, delayHours = config.partyPayoutDelayHours): Date {
  return new Date(partyOverAt(party).getTime() + delayHours * 60 * 60 * 1000);
}

/** A charge with any refund or a dispute is never paid out automatically. */
export function chargeHoldReason(charge: Pick<Stripe.Charge, 'refunded' | 'amount_refunded' | 'disputed' | 'status'> | null): string | null {
  if (!charge) return 'Stripe has no charge for this sale.';
  if (charge.status !== 'succeeded') return `The charge is ${charge.status}.`;
  if (charge.disputed) return 'The guest disputed this charge.';
  if (charge.refunded || charge.amount_refunded > 0) return 'This charge was refunded.';
  return null;
}

const SETTLED = ['paid', 'held'];

async function chargeFor(stripe: Stripe, checkout: { paymentIntentId: string | null; stripeSessionId: string | null }): Promise<Stripe.Charge | null> {
  let paymentIntentId = checkout.paymentIntentId;
  if (!paymentIntentId && checkout.stripeSessionId) {
    const session = await stripe.checkout.sessions.retrieve(checkout.stripeSessionId);
    paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  }
  if (!paymentIntentId) return null;
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  return typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
}

function short(error: unknown): string {
  const message = (error as { message?: string })?.message ?? 'Transfer failed.';
  return message.slice(0, DETAIL_MAX);
}

/**
 * One transfer, exactly once. The row is claimed first; the Stripe call
 * carries an idempotency key, and a retry looks for a transfer already made
 * under this sale's group before making another.
 */
async function sendShare(stripe: Stripe, input: {
  checkoutId: string; partyId: string; recipient: Recipient; recipientUserId: string | null; sellerId: string | null;
  destination: string; amountCents: number; currency: string; chargeId: string;
}): Promise<'paid' | 'failed' | 'settled'> {
  const key = { checkoutId_recipient: { checkoutId: input.checkoutId, recipient: input.recipient } };
  const existing = await db.partyPayoutTransfer.findUnique({ where: key, select: { status: true } });
  if (existing && SETTLED.includes(existing.status)) return 'settled';
  if (!existing) {
    await db.partyPayoutTransfer.create({
      data: {
        checkoutId: input.checkoutId, partyId: input.partyId, recipient: input.recipient,
        recipientUserId: input.recipientUserId, sellerId: input.sellerId,
        destination: input.destination, amountCents: input.amountCents, currency: input.currency,
      },
    }).catch(() => undefined);
  }
  const transferGroup = `party-checkout:${input.checkoutId}`;
  try {
    let transfer: Stripe.Transfer | undefined;
    if (existing) {
      const prior = await stripe.transfers.list({ transfer_group: transferGroup, limit: 10 });
      transfer = prior.data.find((item) => item.metadata?.recipient === input.recipient && !item.reversed);
    }
    transfer ??= await stripe.transfers.create({
      amount: input.amountCents,
      currency: input.currency,
      destination: input.destination,
      source_transaction: input.chargeId,
      transfer_group: transferGroup,
      metadata: { checkoutId: input.checkoutId, partyId: input.partyId, recipient: input.recipient },
    }, { idempotencyKey: `party-payout:${input.checkoutId}:${input.recipient}` });
    await db.partyPayoutTransfer.update({
      where: key,
      data: { status: 'paid', stripeTransferId: transfer.id, destination: input.destination, paidAt: new Date(), detail: null },
    });
    return 'paid';
  } catch (error) {
    await db.partyPayoutTransfer.update({ where: key, data: { status: 'failed', detail: short(error) } }).catch(() => undefined);
    return 'failed';
  }
}

async function holdShares(input: {
  checkoutId: string; partyId: string; reason: string;
  shares: { recipient: Recipient; recipientUserId: string | null; sellerId: string | null; amountCents: number; currency: string }[];
}): Promise<number> {
  let held = 0;
  for (const share of input.shares) {
    const key = { checkoutId_recipient: { checkoutId: input.checkoutId, recipient: share.recipient } };
    const existing = await db.partyPayoutTransfer.findUnique({ where: key, select: { status: true } });
    if (existing && SETTLED.includes(existing.status)) continue;
    await db.partyPayoutTransfer.upsert({
      where: key,
      create: {
        checkoutId: input.checkoutId, partyId: input.partyId, recipient: share.recipient,
        recipientUserId: share.recipientUserId, sellerId: share.sellerId,
        amountCents: share.amountCents, currency: share.currency, status: 'held', detail: input.reason,
      },
      update: { status: 'held', detail: input.reason },
    });
    held++;
  }
  return held;
}

export async function runPartyPayouts(input: { stripe: Stripe; now?: Date; limit?: number }): Promise<PartyPayoutRunResult> {
  const result: PartyPayoutRunResult = { paid: 0, held: 0, failed: 0, waiting: 0 };
  if (!config.partyPayoutsEnabled) return result;
  const now = input.now ?? new Date();
  const delayMs = config.partyPayoutDelayHours * 60 * 60 * 1000;
  const endedBy = new Date(now.getTime() - delayMs);
  const startedBy = new Date(endedBy.getTime() - DEFAULT_PARTY_LENGTH_MS);

  const checkouts = await db.partyCheckout.findMany({
    where: {
      status: 'completed',
      platformFeeBps: { not: null },
      party: { OR: [{ endsAt: { lte: endedBy } }, { endsAt: null, startsAt: { lte: startedBy } }] },
      OR: [
        // A host who has not finished onboarding is not selected, so an
        // owed sale cannot crowd out ones that can be paid.
        {
          hostNetCents: { gt: 0 },
          party: { host: { hostPayoutAccount: { is: { status: 'active' } } } },
          payouts: { none: { recipient: 'host', status: { in: SETTLED } } },
        },
        { sellerId: { not: null }, sellerNetCents: { gt: 0 }, payouts: { none: { recipient: 'seller', status: { in: SETTLED } } } },
      ],
    },
    orderBy: { completedAt: 'asc' },
    take: input.limit ?? 100,
    select: {
      id: true, partyId: true, currency: true, hostNetCents: true, sellerId: true, sellerNetCents: true,
      paymentIntentId: true, stripeSessionId: true,
      party: { select: { hostUserId: true, startsAt: true, endsAt: true } },
      payouts: { select: { recipient: true, status: true } },
    },
  });

  const hostReady = new Map<string, string | null>();
  const sellerReady = new Map<string, string | null>();
  const hostDestination = async (userId: string) => {
    if (!hostReady.has(userId)) {
      const view = await refreshHostPayout(userId, input.stripe);
      const account = view.status === 'active'
        ? await db.hostPayoutAccount.findUnique({ where: { userId }, select: { stripeAccountId: true } })
        : null;
      hostReady.set(userId, account?.stripeAccountId ?? null);
    }
    return hostReady.get(userId) ?? null;
  };
  const sellerDestination = async (sellerId: string) => {
    if (!sellerReady.has(sellerId)) {
      const seller = await db.vendorSeller.findUnique({ where: { id: sellerId }, select: { payoutReference: true, payoutStatus: true } });
      sellerReady.set(sellerId, seller?.payoutStatus === 'active' ? seller.payoutReference : null);
    }
    return sellerReady.get(sellerId) ?? null;
  };

  for (const checkout of checkouts) {
    const settled = new Set(checkout.payouts.filter((row) => SETTLED.includes(row.status)).map((row) => row.recipient));
    const shares: { recipient: Recipient; recipientUserId: string | null; sellerId: string | null; amountCents: number; currency: string }[] = [];
    if ((checkout.hostNetCents ?? 0) > 0 && !settled.has('host')) {
      shares.push({ recipient: 'host', recipientUserId: checkout.party.hostUserId, sellerId: null, amountCents: checkout.hostNetCents!, currency: checkout.currency });
    }
    if (checkout.sellerId && (checkout.sellerNetCents ?? 0) > 0 && !settled.has('seller')) {
      shares.push({ recipient: 'seller', recipientUserId: null, sellerId: checkout.sellerId, amountCents: checkout.sellerNetCents!, currency: checkout.currency });
    }
    if (shares.length === 0) continue;

    let charge: Stripe.Charge | null;
    try {
      charge = await chargeFor(input.stripe, checkout);
    } catch {
      result.failed += shares.length;
      continue;
    }
    const holdReason = chargeHoldReason(charge);
    if (holdReason || !charge) {
      result.held += await holdShares({ checkoutId: checkout.id, partyId: checkout.partyId, reason: holdReason ?? 'No charge.', shares });
      continue;
    }

    for (const share of shares) {
      const destination = share.recipient === 'host'
        ? await hostDestination(share.recipientUserId!)
        : await sellerDestination(share.sellerId!);
      if (!destination) { result.waiting++; continue; }
      const outcome = await sendShare(input.stripe, {
        checkoutId: checkout.id, partyId: checkout.partyId, recipient: share.recipient,
        recipientUserId: share.recipientUserId, sellerId: share.sellerId,
        destination, amountCents: share.amountCents, currency: share.currency, chargeId: charge.id,
      });
      if (outcome === 'paid') result.paid++;
      else if (outcome === 'failed') result.failed++;
    }
  }
  return result;
}
