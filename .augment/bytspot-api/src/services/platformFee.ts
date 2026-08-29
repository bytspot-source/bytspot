import { db } from '../lib/db';
import { config } from '../config';

export const PARTY_TICKET_FEE_SCOPE = 'party-ticket';
/// A fee is a share of a sale, so anything at or above 100% is not a fee.
export const MAX_FEE_BPS = 5_000;

/**
 * The rate a party published right now would be charged. Reading the newest
 * appended row keeps every past rate on record, which is what lets a host
 * dispute a fee and what a Stripe Capital review asks for.
 */
export async function currentPlatformFeeBps(scope = PARTY_TICKET_FEE_SCOPE): Promise<number> {
  const latest = await db.platformFeeSetting
    .findFirst({ where: { scope }, orderBy: { createdAt: 'desc' }, select: { feeBps: true } })
    .catch(() => null);
  return clampFeeBps(latest?.feeBps ?? config.defaultPlatformFeeBps);
}

export function clampFeeBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_FEE_BPS, Math.max(0, Math.round(value)));
}

/**
 * The party's own rate when it has one. A party published before the fee
 * existed has no snapshot, and inventing a retroactive charge for it would bill
 * a host a rate they were never shown, so it falls back to the current rate
 * only for parties that never saw one at all.
 */
export function effectiveFeeBps(snapshot: number | null | undefined, current: number): number {
  return clampFeeBps(snapshot ?? current);
}

/** Split a gross ticket price into the platform fee and the host's net. */
export function splitTicketAmount(amountCents: number, feeBps: number): { feeCents: number; hostNetCents: number } {
  const gross = Math.max(0, Math.round(amountCents));
  // Round the fee down so rounding never favours the platform over the host.
  const feeCents = Math.min(gross, Math.floor((gross * clampFeeBps(feeBps)) / 10_000));
  return { feeCents, hostNetCents: gross - feeCents };
}

/// Stripe's standard US card price. Stripe bills the platform for destination
/// charges whether or not `on_behalf_of` is set, so passing this cost to the
/// host has to be done in the application fee - there is no Stripe flag that
/// does it for us.
export const STRIPE_PROCESSING_BPS = 290;
export const STRIPE_PROCESSING_FIXED_CENTS = 30;

export function stripeProcessingCents(amountCents: number): number {
  const gross = Math.max(0, Math.round(amountCents));
  // Round Stripe's share up: under-collecting means the platform silently eats
  // the shortfall on every sale.
  return Math.ceil((gross * STRIPE_PROCESSING_BPS) / 10_000) + STRIPE_PROCESSING_FIXED_CENTS;
}

/**
 * What Stripe should collect as the application fee, and what the host is left
 * with, when the host bears payment processing.
 *
 * The application fee is the platform's own fee *plus* Stripe's cost, because
 * Stripe deducts its cost from the platform's share of a destination charge.
 * Collecting only the platform fee would leave Bytspot underwater on every
 * ticket: at 150 bps a $25 ticket earns $0.37 against $1.03 of processing.
 *
 * Amex and international cards cost more than the standard rate, and the
 * platform absorbs that difference rather than surprising a host with a fee
 * that moves after the sale.
 */
export function splitTicketWithProcessing(amountCents: number, feeBps: number): {
  platformFeeCents: number;
  processingCents: number;
  applicationFeeCents: number;
  hostNetCents: number;
} {
  const gross = Math.max(0, Math.round(amountCents));
  const { feeCents } = splitTicketAmount(gross, feeBps);
  const processingCents = stripeProcessingCents(gross);
  // A ticket too small to cover processing must never produce a transfer
  // larger than the charge, so the application fee is capped at the ticket.
  const applicationFeeCents = Math.min(gross, feeCents + processingCents);
  return { platformFeeCents: feeCents, processingCents, applicationFeeCents, hostNetCents: gross - applicationFeeCents };
}
