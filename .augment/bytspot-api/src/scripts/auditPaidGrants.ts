/**
 * READ-ONLY audit for REA review 2026-11-10, X5.
 *
 * Lists everything the API granted because Stripe said "paid": party passes
 * bought through Checkout, vendor ticket orders, and Platinum memberships.
 * While production ran on a Stripe test key, any of these could have been
 * obtained with Stripe's public test card. Daniel reviews the list and decides
 * what to revoke; this script never writes to the database or to Stripe.
 *
 * Usage (from .augment/bytspot-api, with DATABASE_URL pointing at the DB to audit):
 *   npx tsx src/scripts/auditPaidGrants.ts              # database only
 *   npx tsx src/scripts/auditPaidGrants.ts --stripe     # also GET each PaymentIntent
 *                                                       # and print its livemode flag
 * Output is CSV on stdout. Emails are masked; ids are kept so rows can be found.
 * `--stripe` performs only read (retrieve) calls with STRIPE_SECRET_KEY; a test
 * key can only see test-mode objects, so a "not found" there usually means
 * the payment was live.
 */
export {};

process.env.BYTSPOT_RUNTIME = 'job';

const mask = (email: string | null | undefined) => {
  if (!email) return '';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain ?? ''}`;
};
const csv = (values: unknown[]) => values.map((v) => {
  const s = v instanceof Date ? v.toISOString() : String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',');

async function main(): Promise<void> {
  const { db } = await import('../lib/db');
  const checkStripe = process.argv.includes('--stripe');
  let stripe: import('stripe').default | null = null;
  if (checkStripe) {
    const { config } = await import('../config');
    const Stripe = (await import('stripe')).default;
    stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
    if (!stripe) console.error('[audit] STRIPE_SECRET_KEY not set; skipping Stripe lookups');
  }
  const livemode = async (paymentIntentId: string | null) => {
    if (!stripe || !paymentIntentId) return '';
    try {
      return String((await stripe.paymentIntents.retrieve(paymentIntentId)).livemode);
    } catch {
      return 'not-visible-to-this-key';
    }
  };

  console.log(csv(['kind', 'row_id', 'user_id', 'email_masked', 'detail', 'amount_cents', 'status', 'payment_intent_id', 'completed_at', 'stripe_livemode']));

  const checkouts = await db.partyCheckout.findMany({
    where: { status: { in: ['completed', 'refund-required', 'refunded'] } },
    select: { id: true, userId: true, partyId: true, ticketTierName: true, amountCents: true, status: true, paymentIntentId: true, completedAt: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const row of checkouts) {
    console.log(csv(['party-checkout', row.id, row.userId, mask(row.user.email), `party=${row.partyId} tier=${row.ticketTierName ?? ''}`, row.amountCents, row.status, row.paymentIntentId, row.completedAt, await livemode(row.paymentIntentId)]));
  }

  const orders = await db.vendorTicketOrder.findMany({
    where: { status: { in: ['settling', 'completed'] } },
    select: { id: true, userId: true, ticketId: true, amountCents: true, status: true, paymentIntentId: true, completedAt: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const row of orders) {
    console.log(csv(['vendor-ticket', row.id, row.userId, mask(row.user.email), `ticket=${row.ticketId}`, row.amountCents, row.status, row.paymentIntentId, row.completedAt, await livemode(row.paymentIntentId)]));
  }

  const members = await db.user.findMany({
    where: { OR: [{ membershipTier: { not: 'green' } }, { isPremium: true }] },
    select: { id: true, email: true, membershipTier: true, isPremium: true, stripeCustomerId: true, updatedAt: true },
  });
  for (const row of members) {
    console.log(csv(['platinum-member', row.id, row.id, mask(row.email), `tier=${row.membershipTier} premium=${row.isPremium} customer=${row.stripeCustomerId ?? ''}`, '', '', '', row.updatedAt, '']));
  }
  console.error(`[audit] party checkouts=${checkouts.length} vendor tickets=${orders.length} members=${members.length}`);
}

main()
  .then(async () => {
    const { db } = await import('../lib/db');
    await db.$disconnect().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[audit] failed', err instanceof Error ? err.message : err);
    process.exit(1);
  });
