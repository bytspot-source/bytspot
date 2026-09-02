import Stripe from 'stripe';
import type { VendorSeller } from '@prisma/client';
import { config } from '../config';
import { db } from '../lib/db';

/**
 * Payouts, through the processor's hosted onboarding.
 *
 * No bank detail reaches this API or the console. Account numbers entered into
 * our own form would live in the DOM, in a devtools snapshot, in any error
 * report that serialises state, and in our logs. We hold a reference and a
 * status we did not compute; `last4` is display text the processor hands back,
 * not a fragment we derived.
 */

export type PayoutStatus = 'pending' | 'active' | 'restricted';

export interface PayoutAccount {
  reference: string;
  status: PayoutStatus;
  last4?: string;
  detail?: string;
}

export const stripeHandle = {
  client: (): Stripe | null => (config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null),
};

export function payoutIsConfigured(): boolean {
  return Boolean(config.stripeSecretKey);
}

/**
 * What the processor currently thinks, mapped to the three states the console
 * knows.
 *
 * `payouts_enabled` is the only signal that means money can actually arrive.
 * `details_submitted` means the vendor finished the form, which is not the same
 * thing and is the usual source of a business going live and then failing to be
 * paid. A requirement past its deadline is a restriction, not a pending step.
 */
export function statusFrom(account: Stripe.Account): { status: PayoutStatus; detail?: string } {
  const requirements = account.requirements;
  const overdue = requirements?.currently_due?.length ?? 0;
  const disabledReason = requirements?.disabled_reason ?? undefined;

  if (account.payouts_enabled && overdue === 0) return { status: 'active' };
  if (disabledReason) return { status: 'restricted', detail: humanize(disabledReason) };
  if (!account.payouts_enabled && account.details_submitted) {
    return { status: 'pending', detail: 'The processor is reviewing these details' };
  }
  return { status: 'pending' };
}

function humanize(reason: string): string {
  // Processor reason codes are dot-cased identifiers. Shown to a vendor, so
  // they are flattened rather than passed through as-is.
  return reason.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function last4Of(account: Stripe.Account): string | undefined {
  const external = account.external_accounts?.data?.[0] as { last4?: string } | undefined;
  return external?.last4;
}

/** The processor's account for this business, created on first use. */
export async function ensureAccount(seller: VendorSeller, stripe: Stripe): Promise<string> {
  if (seller.payoutReference) return seller.payoutReference;

  const account = await stripe.accounts.create({
    type: 'express',
    email: seller.contactEmail ?? undefined,
    business_profile: { name: seller.legalName ?? undefined },
    // Bytspot settles with the guest, so the platform owns the charge and the
    // vendor is paid out of it. An account that could charge independently
    // would put a second merchant of record on the same booking.
    capabilities: { transfers: { requested: true } },
    metadata: { sellerId: seller.id },
  });

  await db.vendorSeller.update({
    where: { id: seller.id },
    data: { payoutReference: account.id, payoutStatus: 'pending' },
  });
  return account.id;
}

/**
 * Reads the processor's view and writes it back.
 *
 * Pulled rather than trusted from our column: onboarding finishes on the
 * processor's domain, so the vendor returns to a console whose stored status is
 * always one step behind. The webhook will say the same thing later; this is
 * what makes the screen right now.
 */
export async function refreshPayout(seller: VendorSeller): Promise<PayoutAccount | undefined> {
  if (!seller.payoutReference) return undefined;
  const stripe = stripeHandle.client();
  if (!stripe) return storedPayout(seller);

  try {
    const account = await stripe.accounts.retrieve(seller.payoutReference);
    const { status, detail } = statusFrom(account);
    const last4 = last4Of(account);

    await db.vendorSeller.update({
      where: { id: seller.id },
      data: { payoutStatus: status, payoutLast4: last4 ?? null, payoutDetail: detail ?? null },
    });
    return { reference: seller.payoutReference, status, last4, detail };
  } catch {
    // The processor being unreachable must not read as "no payout account".
    return storedPayout(seller);
  }
}

export function storedPayout(seller: VendorSeller): PayoutAccount | undefined {
  if (!seller.payoutReference) return undefined;
  const status = seller.payoutStatus;
  return {
    reference: seller.payoutReference,
    status: status === 'active' || status === 'restricted' ? status : 'pending',
    last4: seller.payoutLast4 ?? undefined,
    detail: seller.payoutDetail ?? undefined,
  };
}

/**
 * A single-use link into hosted onboarding.
 *
 * Short-lived by the processor's design, so it is minted per request and never
 * stored. The console opens it rather than framing it: an iframe would put the
 * processor's form inside a page that also renders vendor-supplied strings.
 */
export async function onboardingLink(
  seller: VendorSeller,
  origin: string,
): Promise<{ reference: string; url: string } | undefined> {
  const stripe = stripeHandle.client();
  if (!stripe) return undefined;

  const reference = await ensureAccount(seller, stripe);
  const link = await stripe.accountLinks.create({
    account: reference,
    type: 'account_onboarding',
    refresh_url: `${origin}/payout/retry`,
    return_url: `${origin}/payout/done`,
  });
  return { reference, url: link.url };
}
