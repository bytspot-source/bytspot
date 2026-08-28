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

export type SaleableAccount =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'no-account' | 'incomplete' | 'unverifiable' };

/**
 * How long Stripe's last verdict is allowed to stand for a sale. Stripe pushes
 * `account.updated` when this changes, so the mirror is normally current; this
 * window only bounds how long a missed delivery could matter.
 */
export const READINESS_FRESH_WINDOW_MS = 60_000;

/**
 * The only readiness check a sale may rely on. It always asks Stripe, because
 * a mirror that says ready is exactly the state Stripe can revoke without
 * telling us, and it fails closed when Stripe cannot be reached: refusing a
 * sale is recoverable, taking a guest's money with nowhere to send it is not.
 */
export async function saleablePayoutAccount(userId: string, now = Date.now()): Promise<SaleableAccount> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { stripeAccountId: true, stripeChargesEnabled: true, stripePayoutsEnabled: true, stripeAccountRefreshedAt: true },
  });
  const accountId = row?.stripeAccountId ?? null;
  if (!accountId) return { ok: false, reason: 'no-account' };

  const refreshedAt = row?.stripeAccountRefreshedAt?.getTime() ?? 0;
  if (now - refreshedAt <= READINESS_FRESH_WINDOW_MS) {
    return payoutReadiness(row).ready ? { ok: true, accountId } : { ok: false, reason: 'incomplete' };
  }
  try {
    const fresh = await refreshHostAccount(userId, accountId);
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
