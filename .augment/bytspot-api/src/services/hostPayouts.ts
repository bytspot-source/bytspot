import type Stripe from 'stripe';
import type { HostPayoutAccount } from '@prisma/client';
import { config } from '../config';
import { db } from '../lib/db';
import { last4Of, statusFrom, stripeHandle, type PayoutStatus } from '../vendor/payout';

/**
 * Host payouts, through the same hosted Stripe Express onboarding businesses
 * use. No bank detail reaches this API: the host enters it on Stripe's pages,
 * and changes it in the Stripe Express dashboard.
 */

export interface HostPayoutView {
  status: PayoutStatus | 'none';
  last4: string | null;
  detail: string | null;
  /** Party sales are paid out by transfer only while this is on. */
  payoutsLive: boolean;
}

export const HOST_PAYOUT_RETURN_PATH = '/payouts/host/return';
export const HOST_PAYOUT_REFRESH_PATH = '/payouts/host/refresh';

export function hostPayoutView(account: Pick<HostPayoutAccount, 'status' | 'last4' | 'detail'> | null): HostPayoutView {
  return {
    status: account?.status ?? 'none',
    last4: account?.last4 ?? null,
    detail: account?.detail ?? null,
    payoutsLive: config.partyPayoutsEnabled,
  };
}

/** The host's Express account, created on first use. */
export async function ensureHostAccount(userId: string, stripe: Stripe): Promise<string> {
  const existing = await db.hostPayoutAccount.findUnique({ where: { userId }, select: { stripeAccountId: true } });
  if (existing) return existing.stripeAccountId;
  const user = await db.user.findFirst({ where: { id: userId, deletedAt: null }, select: { email: true } });
  if (!user) throw new Error('Host account not found.');

  const account = await stripe.accounts.create({
    type: 'express',
    email: user.email,
    business_type: 'individual',
    // Bytspot stays the merchant of record for every ticket; the host is paid
    // out of the platform's charge, never charged through their own account.
    capabilities: { transfers: { requested: true } },
    metadata: { userId, kind: 'party-host' },
  }, { idempotencyKey: `host-payout-account:${userId}` });

  const row = await db.hostPayoutAccount.upsert({
    where: { userId },
    create: { userId, stripeAccountId: account.id, status: 'pending' },
    update: {},
    select: { stripeAccountId: true },
  });
  return row.stripeAccountId;
}

/** Stripe's current view, written back. Unreachable Stripe keeps the stored view. */
export async function refreshHostPayout(userId: string, stripe: Stripe | null = stripeHandle.client()): Promise<HostPayoutView> {
  const stored = await db.hostPayoutAccount.findUnique({ where: { userId } });
  if (!stored || !stripe) return hostPayoutView(stored);
  try {
    const account = await stripe.accounts.retrieve(stored.stripeAccountId);
    const { status, detail } = statusFrom(account);
    const updated = await db.hostPayoutAccount.update({
      where: { userId },
      data: { status, last4: last4Of(account) ?? null, detail: detail ?? null },
    });
    return hostPayoutView(updated);
  } catch {
    return hostPayoutView(stored);
  }
}

/** A single-use onboarding link. Minted per request and never stored. */
export async function hostOnboardingLink(userId: string): Promise<{ url: string } | null> {
  const stripe = stripeHandle.client();
  if (!stripe) return null;
  const account = await ensureHostAccount(userId, stripe);
  const link = await stripe.accountLinks.create({
    account,
    type: 'account_onboarding',
    refresh_url: `${config.publicApiUrl}${HOST_PAYOUT_REFRESH_PATH}`,
    return_url: `${config.publicApiUrl}${HOST_PAYOUT_RETURN_PATH}`,
  });
  return { url: link.url };
}

/** The Stripe Express dashboard, where the host changes their bank. */
export async function hostDashboardLink(userId: string): Promise<{ url: string } | null> {
  const stripe = stripeHandle.client();
  const stored = await db.hostPayoutAccount.findUnique({ where: { userId }, select: { stripeAccountId: true } });
  if (!stripe || !stored) return null;
  const link = await stripe.accounts.createLoginLink(stored.stripeAccountId);
  return { url: link.url };
}

type TicketTierShape = { priceCents?: unknown };

export function partySellsPaidTickets(ticketTiers: unknown): boolean {
  return Array.isArray(ticketTiers)
    && ticketTiers.some((tier) => typeof (tier as TicketTierShape)?.priceCents === 'number' && ((tier as TicketTierShape).priceCents as number) > 0);
}

/**
 * Whether this host may publish a party that sells paid tickets. Free parties
 * never need payouts. While party payouts are off, nothing is required.
 */
export async function hostCanSellPaidTickets(userId: string): Promise<boolean> {
  if (!config.partyPayoutsEnabled) return true;
  const stored = await db.hostPayoutAccount.findUnique({ where: { userId }, select: { status: true } });
  if (stored?.status === 'active') return true;
  if (!stored) return false;
  return (await refreshHostPayout(userId)).status === 'active';
}
