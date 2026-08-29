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
export async function refreshHostAccount(userId: string, accountId: string, stripe?: ReadinessStripe): Promise<HostPayoutReadiness> {
  const account = await (stripe ?? readinessOverride ?? stripeClient()).accounts.retrieve(accountId);
  const chargesEnabled = Boolean(account.charges_enabled);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  await db.user.update({
    where: { id: userId },
    data: { stripeChargesEnabled: chargesEnabled, stripePayoutsEnabled: payoutsEnabled, stripeAccountRefreshedAt: new Date() },
  });
  return payoutReadiness({ stripeAccountId: accountId, stripeChargesEnabled: chargesEnabled, stripePayoutsEnabled: payoutsEnabled });
}

/**
 * Status display only. A stale mirror here costs a host an out-of-date screen;
 * it must never be what a sale is decided on. Money gates use
 * {@link saleablePayoutAccount}.
 */
export async function currentHostPayoutReadiness(userId: string): Promise<HostPayoutReadiness> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true, stripeChargesEnabled: true, stripePayoutsEnabled: true },
  });
  const mirrored = payoutReadiness(row);
  if (!mirrored.accountId) return mirrored;
  return refreshHostAccount(userId, mirrored.accountId).catch(() => mirrored);
}

/** The single Stripe call a readiness check makes, so a test can supply it. */
export type ReadinessStripe = { accounts: { retrieve: (id: string) => Promise<{ charges_enabled?: boolean; payouts_enabled?: boolean }> } };

let readinessOverride: ReadinessStripe | undefined;

/**
 * Lets a test exercise the sale gates, which reach Stripe through the router
 * and so cannot be passed a client. Refused outright in production: a live
 * deployment must never be able to substitute its own readiness verdict.
 */
export function setReadinessStripeForTests(client?: ReadinessStripe): void {
  if (config.nodeEnv === 'production') throw new Error('Readiness client cannot be overridden in production.');
  readinessOverride = client;
}

export type SaleableAccount =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'no-account' | 'incomplete' | 'unverifiable' };

/**
 * The only readiness check a sale may rely on. It always asks Stripe, with no
 * freshness window: a mirror that says ready is exactly the state Stripe can
 * revoke without a delivered `account.updated`, so trusting it for even a
 * minute can transfer a guest's money to an account the host cannot withdraw
 * from. It fails closed when Stripe cannot be reached, because refusing a sale
 * is recoverable and taking money with nowhere to send it is not.
 *
 * The local mirror remains for display only. See `hostPayoutStatus`.
 */
export async function saleablePayoutAccount(userId: string, stripe?: ReadinessStripe): Promise<SaleableAccount> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true },
  });
  const accountId = row?.stripeAccountId ?? null;
  if (!accountId) return { ok: false, reason: 'no-account' };

  try {
    const fresh = await refreshHostAccount(userId, accountId, stripe);
    return fresh.ready ? { ok: true, accountId } : { ok: false, reason: 'incomplete' };
  } catch {
    return { ok: false, reason: 'unverifiable' };
  }
}

/** Mirror Stripe's own `account.updated` verdict. */
export async function applyAccountUpdate(account: { id: string; charges_enabled?: boolean; payouts_enabled?: boolean }): Promise<void> {
  await db.user.updateMany({
    where: { stripeAccountId: account.id },
    data: {
      stripeChargesEnabled: Boolean(account.charges_enabled),
      stripePayoutsEnabled: Boolean(account.payouts_enabled),
      stripeAccountRefreshedAt: new Date(),
    },
  });
}
