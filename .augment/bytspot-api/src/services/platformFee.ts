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
