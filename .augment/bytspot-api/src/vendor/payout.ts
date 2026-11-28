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

  // A recipient account is paid by transfer, so an active transfers capability counts as well as payouts.
  const canReceive = account.payouts_enabled || account.capabilities?.transfers === 'active';
  if (canReceive && overdue === 0) return { status: 'active' };
  if (disabledReason) return { status: 'restricted', detail: humanize(disabledReason) };
  if (!canReceive && account.details_submitted) {
    return { status: 'pending', detail: 'The processor is reviewing these details' };
  }
  return { status: 'pending' };
}

/**
 * The same three states for an Accounts v2 recipient. Its v1 view lists
 * requirements for configurations it never asked for, so it would read as
 * pending forever and send a finished owner back to Stripe in a loop. What
 * counts is the stripe_transfers capability.
 */
export function statusFromV2(account: Stripe.V2.Core.Account): { status: PayoutStatus; detail?: string } {
  const transfers = account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers;
  if (!transfers) return { status: 'pending' };
  if (transfers.status === 'active') return { status: 'active' };
  const code = transfers.status_details?.[0]?.code;
  if (code === 'requirements_past_due') return { status: 'pending', detail: 'Stripe needs a few more details' };
  if (code === 'requirements_pending_verification' || code === 'determining_status') {
    return { status: 'pending', detail: 'The processor is reviewing these details' };
  }
  if (transfers.status === 'restricted' || transfers.status === 'unsupported') {
    return { status: 'restricted', detail: code ? humanize(code) : undefined };
  }
  return { status: 'pending' };
}

function humanize(reason: string): string {
  // Processor reason codes are dot-cased identifiers. Shown to a vendor, so
  // they are flattened rather than passed through as-is.
  return reason.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function last4Of(account: Stripe.Account): string | undefined {
  const external = account.external_accounts?.data?.[0] as { last4?: string } | undefined;
  return external?.last4;
}

/**
 * A connected account that can only receive transfers, with the Express
 * dashboard. Bytspot is the merchant of record and pays the fees and any
 * losses from refunds or disputes, which Stripe only accepts through Accounts v2.
 */
export async function createRecipientAccount(
  stripe: Stripe,
  input: { email?: string | null; name?: string | null; metadata: Record<string, string>; idempotencyKey?: string },
): Promise<string> {
  const account = await stripe.v2.core.accounts.create({
    ...(input.email ? { contact_email: input.email } : {}),
    ...(input.name ? { display_name: input.name } : {}),
    dashboard: 'express',
    identity: { country: 'us' },
    defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    metadata: input.metadata,
  }, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined);
  return account.id;
}

/**
 * A single-use link into Stripe's hosted onboarding for a recipient account.
 *
 * Asks for everything the account will need (`eventually_due`): with only
 * what is due today, Stripe can find nothing to ask a new account and sends
 * the owner straight back without showing its form.
 */
export async function recipientOnboardingUrl(stripe: Stripe, account: string, urls: { refresh: string; return: string }): Promise<string> {
  try {
    const link = await stripe.v2.core.accountLinks.create({
      account,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['recipient'], refresh_url: urls.refresh, return_url: urls.return,
          collection_options: { fields: 'eventually_due' },
        },
      },
    });
    return link.url;
  } catch (error) {
    // Only an account made before Accounts v2 takes a v1 link. A v1 link for a
    // v2 account opens nothing and bounces the owner back, so anything else fails loudly.
    if (!(await isV1Account(stripe, account))) throw error;
    const link = await stripe.accountLinks.create({
      account, type: 'account_onboarding', refresh_url: urls.refresh, return_url: urls.return,
      collection_options: { fields: 'eventually_due' },
    });
    return link.url;
  }
}

async function isV1Account(stripe: Stripe, account: string): Promise<boolean> {
  try {
    const v2 = await stripe.v2.core.accounts.retrieve(account, { include: ['configuration.recipient'] });
    return !v2.configuration?.recipient;
  } catch {
    return true;
  }
}

/** The processor's account for this business, created on first use. */
export async function ensureAccount(seller: VendorSeller, stripe: Stripe): Promise<string> {
  if (seller.payoutReference) return seller.payoutReference;

  // Bytspot settles with the guest, so the platform owns the charge and the
  // vendor is paid out of it. An account that could charge independently
  // would put a second merchant of record on the same booking.
  const accountId = await createRecipientAccount(stripe, {
    email: seller.contactEmail, name: seller.legalName, metadata: { sellerId: seller.id }, idempotencyKey: `vendor-payout-account:${seller.id}`,
  });
  const account = { id: accountId };

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
    const read = await readAccountStatus(stripe, seller.payoutReference);
    const { status, detail } = read;
    const last4 = read.last4 ?? seller.payoutLast4 ?? undefined;

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

/** An Accounts v2 recipient is read through v2; an account made before it only through v1. */
async function readAccountStatus(stripe: Stripe, reference: string): Promise<{ status: PayoutStatus; detail?: string; last4?: string }> {
  try {
    const account = await stripe.v2.core.accounts.retrieve(reference, { include: ['configuration.recipient', 'requirements'] });
    if (account.configuration?.recipient) return statusFromV2(account);
  } catch {
    // Not a v2 account, or v2 unavailable: read it through v1.
  }
  const account = await stripe.accounts.retrieve(reference);
  return { ...statusFrom(account), last4: last4Of(account) };
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
  const url = await recipientOnboardingUrl(stripe, reference, { refresh: `${origin}/payout/retry`, return: `${origin}/payout/done` });
  return { reference, url };
}

/**
 * Stripe's account.updated for a business's payout account: writes the status
 * it reports, so the business can go live without waiting for its owner to
 * reopen the console. False for an event that is not ours.
 */
export async function applyPayoutAccountEvent(
  event: Stripe.Event,
  advance: (sellerId: string) => Promise<void>,
): Promise<boolean> {
  if (event.type !== 'account.updated') return false;
  const account = event.data.object as Stripe.Account;
  const seller = await db.vendorSeller.findFirst({ where: { payoutReference: account.id }, select: { id: true, payoutLast4: true } });
  if (!seller) return false;
  // The event carries the v1 view, which misreads a v2 recipient; ask Stripe the way refreshPayout does.
  const stripe = stripeHandle.client();
  const read = stripe ? await readAccountStatus(stripe, account.id).catch(() => null) : null;
  const { status, detail } = read ?? statusFrom(account);
  const last4 = read ? read.last4 ?? seller.payoutLast4 ?? undefined : last4Of(account);
  await db.vendorSeller.update({
    where: { id: seller.id },
    data: { payoutStatus: status, payoutLast4: last4 ?? null, payoutDetail: detail ?? null },
  });
  await advance(seller.id);
  return true;
}
