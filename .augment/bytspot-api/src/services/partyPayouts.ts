import type Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { last4Of, statusFrom } from '../vendor/payout';
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
 *
 * Refunds are made in the Stripe dashboard, so a sale can be refunded after
 * its shares were sent. Each paid share's charge is checked again for
 * REVERSAL_WINDOW_DAYS, and the refunded part, or all of it on a dispute, is
 * taken back by transfer reversal. Failures are reported once each.
 */

const DEFAULT_PARTY_LENGTH_MS = 6 * 60 * 60 * 1000;
const DETAIL_MAX = 200;
const HOUR_MS = 60 * 60 * 1000;
/** Card disputes can be opened up to 120 days after payment. */
export const REVERSAL_WINDOW_DAYS = 120;
const RECHECK_EVERY_MS = 6 * HOUR_MS;
/** A failed share waits this long before the next try, so it cannot crowd out others. */
const RETRY_FAILED_MS = 6 * HOUR_MS;
/** Payout accounts not yet active, re-read from Stripe per run. */
const ACCOUNT_REFRESH_LIMIT = 50;
const REVERSAL_FAILED = 'Reversal failed: ';

export type Recipient = 'host' | 'seller';

export interface PartyPayoutRunResult {
  paid: number;
  held: number;
  failed: number;
  waiting: number;
  reversed: number;
  /** New problems a person has to look at. Each is reported once. */
  alerts: string[];
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

const SETTLED = ['paid', 'held', 'reversed'];

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * How much of a paid share should have been taken back: all of it on a
 * dispute, otherwise the refunded fraction of the charge, rounded to the cent.
 */
export function reversalOwedCents(shareCents: number, charge: Pick<Stripe.Charge, 'amount' | 'amount_refunded' | 'disputed'>): number {
  if (charge.disputed) return shareCents;
  if (charge.amount <= 0 || charge.amount_refunded <= 0) return 0;
  return Math.min(shareCents, Math.round(shareCents * charge.amount_refunded / charge.amount));
}

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
 * One transfer, exactly once. The row is claimed first and nothing is sent
 * without it. Before any send, the sale's transfer group is searched for a
 * transfer already made, since Stripe forgets idempotency keys after a day.
 */
async function sendShare(stripe: Stripe, input: {
  checkoutId: string; partyId: string; recipient: Recipient; recipientUserId: string | null; sellerId: string | null;
  destination: string; amountCents: number; currency: string; chargeId: string;
}): Promise<'paid' | 'failed' | 'failed-again' | 'settled'> {
  const key = { checkoutId_recipient: { checkoutId: input.checkoutId, recipient: input.recipient } };
  const existing = await db.partyPayoutTransfer.findUnique({ where: key, select: { status: true } });
  if (existing && SETTLED.includes(existing.status)) return 'settled';
  if (!existing) {
    try {
      await db.partyPayoutTransfer.create({
        data: {
          checkoutId: input.checkoutId, partyId: input.partyId, recipient: input.recipient,
          recipientUserId: input.recipientUserId, sellerId: input.sellerId,
          destination: input.destination, amountCents: input.amountCents, currency: input.currency,
        },
      });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') return 'failed';
      const raced = await db.partyPayoutTransfer.findUnique({ where: key, select: { status: true } });
      if (!raced || SETTLED.includes(raced.status)) return 'settled';
    }
  }
  const transferGroup = `party-checkout:${input.checkoutId}`;
  try {
    const prior = await stripe.transfers.list({ transfer_group: transferGroup, limit: 10 });
    let transfer = prior.data.find((item) => item.metadata?.recipient === input.recipient);
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
    return existing?.status === 'failed' ? 'failed-again' : 'failed';
  }
}

/**
 * Takes back what a refund or dispute says a paid share no longer owes.
 * Keyed by the total owed, so a retry never reverses the same amount twice.
 */
async function reverseRefunded(stripe: Stripe, now: Date, result: PartyPayoutRunResult, limit: number): Promise<void> {
  const rows = await db.partyPayoutTransfer.findMany({
    where: {
      status: 'paid',
      stripeTransferId: { not: null },
      paidAt: { gte: new Date(now.getTime() - REVERSAL_WINDOW_DAYS * 24 * HOUR_MS) },
      OR: [{ checkedAt: null }, { checkedAt: { lte: new Date(now.getTime() - RECHECK_EVERY_MS) } }],
    },
    orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } },
    take: limit,
    select: {
      id: true, checkoutId: true, recipient: true, amountCents: true, reversedCents: true, stripeTransferId: true, detail: true,
      checkout: { select: { paymentIntentId: true, stripeSessionId: true } },
    },
  });

  const charges = new Map<string, Stripe.Charge | null>();
  for (const row of rows) {
    if (!charges.has(row.checkoutId)) {
      try {
        charges.set(row.checkoutId, await chargeFor(stripe, row.checkout));
      } catch {
        continue;
      }
    }
    const charge = charges.get(row.checkoutId);
    if (!charge) {
      await db.partyPayoutTransfer.update({ where: { id: row.id }, data: { checkedAt: now } });
      continue;
    }
    const owed = reversalOwedCents(row.amountCents, charge);
    const delta = owed - row.reversedCents;
    if (delta <= 0) {
      await db.partyPayoutTransfer.update({ where: { id: row.id }, data: { checkedAt: now } });
      continue;
    }
    const reason = charge.disputed ? 'The guest disputed this charge.' : 'This charge was refunded.';
    try {
      await stripe.transfers.createReversal(row.stripeTransferId!, {
        amount: delta,
        metadata: { checkoutId: row.checkoutId, recipient: row.recipient },
      }, { idempotencyKey: `party-payout-reversal:${row.stripeTransferId}:${owed}` });
      await db.partyPayoutTransfer.update({
        where: { id: row.id },
        data: {
          reversedCents: owed, checkedAt: now,
          status: owed >= row.amountCents ? 'reversed' : 'paid',
          detail: `${reason} ${dollars(owed)} of ${dollars(row.amountCents)} taken back.`,
        },
      });
      result.reversed++;
    } catch (error) {
      const detail = `${REVERSAL_FAILED}${short(error)}`.slice(0, DETAIL_MAX);
      if (!row.detail?.startsWith(REVERSAL_FAILED)) {
        result.alerts.push(`Could not take back ${dollars(delta)} from the ${row.recipient} of sale ${row.checkoutId} (transfer ${row.stripeTransferId}): ${short(error)}`);
      }
      await db.partyPayoutTransfer.update({ where: { id: row.id }, data: { checkedAt: now, detail } }).catch(() => undefined);
      result.failed++;
    }
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

/**
 * Accounts that finish onboarding on Stripe's pages are only seen as active
 * once read back. Hosts' and owed businesses' accounts that are not active yet
 * are re-read here, oldest first, so their owed sales are picked up.
 */
async function refreshWaitingAccounts(stripe: Stripe, owedSellerIds: string[]): Promise<Map<string, string>> {
  const hosts = await db.hostPayoutAccount.findMany({
    where: { status: { not: 'active' } },
    orderBy: { updatedAt: 'asc' },
    take: ACCOUNT_REFRESH_LIMIT,
    select: { userId: true },
  });
  for (const host of hosts) await refreshHostPayout(host.userId, stripe);

  const activeSellers = new Map<string, string>();
  if (owedSellerIds.length === 0) return activeSellers;
  const sellers = await db.vendorSeller.findMany({
    where: { id: { in: owedSellerIds }, payoutReference: { not: null } },
    orderBy: { updatedAt: 'asc' },
    select: { id: true, payoutReference: true, payoutStatus: true },
  });
  let refreshed = 0;
  for (const seller of sellers) {
    let status = seller.payoutStatus;
    if (status !== 'active' && refreshed < ACCOUNT_REFRESH_LIMIT) {
      refreshed++;
      try {
        const account = await stripe.accounts.retrieve(seller.payoutReference!);
        const read = statusFrom(account);
        status = read.status;
        await db.vendorSeller.update({
          where: { id: seller.id },
          data: { payoutStatus: read.status, payoutLast4: last4Of(account) ?? null, payoutDetail: read.detail ?? null },
        });
      } catch {
        // Unreachable Stripe keeps the stored status.
      }
    }
    if (status === 'active') activeSellers.set(seller.id, seller.payoutReference!);
  }
  return activeSellers;
}

export async function runPartyPayouts(input: { stripe: Stripe; now?: Date; limit?: number }): Promise<PartyPayoutRunResult> {
  const result: PartyPayoutRunResult = { paid: 0, held: 0, failed: 0, waiting: 0, reversed: 0, alerts: [] };
  if (!config.partyPayoutsEnabled) return result;
  const now = input.now ?? new Date();
  const delayMs = config.partyPayoutDelayHours * 60 * 60 * 1000;
  const endedBy = new Date(now.getTime() - delayMs);
  const startedBy = new Date(endedBy.getTime() - DEFAULT_PARTY_LENGTH_MS);
  const retryBefore = new Date(now.getTime() - RETRY_FAILED_MS);
  const due = {
    status: 'completed',
    platformFeeBps: { not: null },
    party: { OR: [{ endsAt: { lte: endedBy } }, { endsAt: null, startsAt: { lte: startedBy } }] },
  };
  const owedTo = (recipient: Recipient) => ({
    AND: [
      { payouts: { none: { recipient, status: { in: SETTLED } } } },
      { payouts: { none: { recipient, status: 'failed', updatedAt: { gt: retryBefore } } } },
    ],
  });

  const owedSellers = await db.partyCheckout.findMany({
    where: { ...due, sellerId: { not: null }, sellerNetCents: { gt: 0 }, ...owedTo('seller') },
    distinct: ['sellerId'],
    select: { sellerId: true },
  });
  const activeSellers = await refreshWaitingAccounts(input.stripe, owedSellers.map((row) => row.sellerId!).filter(Boolean));

  // Only shares that can be paid now are selected, so sales waiting on a
  // recipient's onboarding, or on a recent failure, cannot crowd them out.
  const checkouts = await db.partyCheckout.findMany({
    where: {
      ...due,
      OR: [
        { hostNetCents: { gt: 0 }, party: { host: { hostPayoutAccount: { is: { status: 'active' } } } }, ...owedTo('host') },
        { sellerId: { in: [...activeSellers.keys()] }, sellerNetCents: { gt: 0 }, ...owedTo('seller') },
      ],
    },
    orderBy: { completedAt: 'asc' },
    take: input.limit ?? 100,
    select: {
      id: true, partyId: true, currency: true, hostNetCents: true, sellerId: true, sellerNetCents: true,
      paymentIntentId: true, stripeSessionId: true,
      party: { select: { hostUserId: true, startsAt: true, endsAt: true } },
      payouts: { select: { recipient: true, status: true, updatedAt: true } },
    },
  });

  const hostReady = new Map<string, string | null>();
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
  const sellerDestination = async (sellerId: string) => activeSellers.get(sellerId) ?? null;

  for (const checkout of checkouts) {
    const settled = new Set(checkout.payouts
      .filter((row) => SETTLED.includes(row.status) || (row.status === 'failed' && row.updatedAt > retryBefore))
      .map((row) => row.recipient));
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
      else if (outcome === 'failed' || outcome === 'failed-again') result.failed++;
      if (outcome === 'failed') {
        result.alerts.push(`Could not pay ${dollars(share.amountCents)} to the ${share.recipient} of sale ${checkout.id}. It will be retried every 6 hours.`);
      }
    }
  }
  await reverseRefunded(input.stripe, now, result, input.limit ?? 100);
  return result;
}
