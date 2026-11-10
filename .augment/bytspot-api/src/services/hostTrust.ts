import { config } from '../config';
import { db } from '../lib/db';

/**
 * REA review 2026-11-10, X1/X2. Until a host has a track record, Bytspot (the
 * merchant of record on every party charge) limits what they can sell and
 * waits longer before paying them, so a chargeback lands before the money
 * has left. Defaults are proposed, conservative values; Daniel tunes them in
 * Render env without a deploy:
 *   NEW_HOST_TRUSTED_AFTER_PARTIES  (3)   paid parties that ended cleanly
 *   NEW_HOST_MAX_TICKET_CENTS       (20000 = $200 per ticket tier price)
 *   NEW_HOST_MAX_TICKET_QUANTITY    (200 per tier)
 *   NEW_HOST_PAYOUT_DELAY_HOURS     (168 = 7 days after the party ends)
 */
export const NEW_HOST_SETTLE_DAYS = 7;

/** Parties this host ran that sold at least one paid pass and ended a week ago. */
export async function hostSettledPaidParties(userId: string, now = new Date()): Promise<number> {
  const settledBefore = new Date(now.getTime() - NEW_HOST_SETTLE_DAYS * 86_400_000);
  return db.party.count({
    where: {
      hostUserId: userId,
      status: 'published',
      moderationHiddenAt: null,
      checkouts: { some: { status: 'completed' } },
      OR: [{ endsAt: { lte: settledBefore } }, { endsAt: null, startsAt: { lte: settledBefore } }],
    },
  });
}

export async function isNewHost(userId: string, now = new Date()): Promise<boolean> {
  if (config.newHostTrustedAfterParties <= 0) return false;
  return (await hostSettledPaidParties(userId, now)) < config.newHostTrustedAfterParties;
}

type TierShape = { name?: unknown; priceCents?: unknown; quantity?: unknown };

/** What a new host's ticket tiers break, or null. Pure, so it is tested directly. */
export function newHostTierProblem(
  ticketTiers: unknown,
  limits = { maxCents: config.newHostMaxTicketCents, maxQuantity: config.newHostMaxTicketQuantity },
): string | null {
  if (!Array.isArray(ticketTiers)) return null;
  for (const tier of ticketTiers as TierShape[]) {
    const price = typeof tier?.priceCents === 'number' ? tier.priceCents : 0;
    const quantity = typeof tier?.quantity === 'number' ? tier.quantity : 0;
    if (price <= 0) continue;
    if (price > limits.maxCents) {
      return `New hosts can sell tickets up to $${(limits.maxCents / 100).toFixed(0)} each until ${config.newHostTrustedAfterParties} paid parties have run.`;
    }
    if (quantity > limits.maxQuantity) {
      return `New hosts can sell up to ${limits.maxQuantity} paid tickets per tier until ${config.newHostTrustedAfterParties} paid parties have run.`;
    }
  }
  return null;
}

/** Hours after the party ends before this host's share may be transferred. */
export async function hostPayoutDelayHours(userId: string, now = new Date()): Promise<number> {
  return (await isNewHost(userId, now))
    ? Math.max(config.partyPayoutDelayHours, config.newHostPayoutDelayHours)
    : config.partyPayoutDelayHours;
}
