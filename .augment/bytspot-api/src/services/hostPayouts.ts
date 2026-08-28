import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';

/**
 * Funds reach the host's connected balance at purchase, but sit there for a
 * week before Stripe pays them out to a bank. A refund or a cancelled party
 * stays reversible for that window instead of becoming a debt Bytspot has to
 * chase a host for.
 */
export const PAYOUT_DELAY_DAYS = 7;

export type HostPayoutReadiness = {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  ready: boolean;
};

type HostAccountRow = {
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
};

/**
 * A host is payout-ready only when Stripe will both take the charge and pay
 * the proceeds out. Either flag alone is a trap: charges without payouts sells
 * tickets for money the host can never withdraw.
 */
export function payoutReadiness(row: HostAccountRow | null | undefined): HostPayoutReadiness {
  const accountId = row?.stripeAccountId ?? null;
  const chargesEnabled = Boolean(row?.stripeChargesEnabled);
  const payoutsEnabled = Boolean(row?.stripePayoutsEnabled);
  return { accountId, chargesEnabled, payoutsEnabled, ready: Boolean(accountId) && chargesEnabled && payoutsEnabled };
}

function stripeClient(): Stripe {
  if (!config.stripeSecretKey) throw new Error('Stripe is not configured.');
  return new Stripe(config.stripeSecretKey);
}

/** Express: Stripe owns identity, bank details, payout dashboard and tax forms. */
export async function ensureHostAccount(userId: string, email: string): Promise<string> {
  const existing = await db.user.findUnique({ where: { id: userId }, select: { stripeAccountId: true } });
  if (existing?.stripeAccountId) return existing.stripeAccountId;

  const account = await stripeClient().accounts.create({
    type: 'express',
    email,
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    business_type: 'individual',
    settings: { payouts: { schedule: { interval: 'daily', delay_days: PAYOUT_DELAY_DAYS } } },
    metadata: { bytspotUserId: userId },
  });
  await db.user.update({ where: { id: userId }, data: { stripeAccountId: account.id } });
  return account.id;
}

export async function hostOnboardingLink(accountId: string, returnPath: string): Promise<string> {
  const link = await stripeClient().accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    return_url: `${config.partyShareBaseUrl}${returnPath}?payouts=return`,
    refresh_url: `${config.partyShareBaseUrl}${returnPath}?payouts=refresh`,
  });
  return link.url;
}

/**
 * Re-read Stripe's verdict and mirror it locally. Called at the two moments
 * that decide money — a host checking their status, and a paid party trying to
 * publish — so a stale mirror can never gate or ungate a sale on its own.
 */
export async function refreshHostAccount(userId: string, accountId: string): Promise<HostPayoutReadiness> {
  const account = await stripeClient().accounts.retrieve(accountId);
  const chargesEnabled = Boolean(account.charges_enabled);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  await db.user.update({
    where: { id: userId },
    data: { stripeChargesEnabled: chargesEnabled, stripePayoutsEnabled: payoutsEnabled, stripeAccountRefreshedAt: new Date() },
  });
  return payoutReadiness({ stripeAccountId: accountId, stripeChargesEnabled: chargesEnabled, stripePayoutsEnabled: payoutsEnabled });
}

/**
 * The mirror answers first so a ready host never waits on Stripe, and only a
 * not-ready mirror pays for a live re-read. That way the slow path is the one
 * that is about to block a host, which is exactly where staleness would be
 * unfair.
 */
export async function currentHostPayoutReadiness(userId: string): Promise<HostPayoutReadiness> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true, stripeChargesEnabled: true, stripePayoutsEnabled: true },
  });
  const mirrored = payoutReadiness(row);
  if (mirrored.ready || !mirrored.accountId) return mirrored;
  return refreshHostAccount(userId, mirrored.accountId).catch(() => mirrored);
}
