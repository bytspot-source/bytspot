/**
 * Scheduled entry point for the deletion promise.
 *
 * Runs against the database directly rather than calling the HTTP endpoint, so
 * the schedule needs no shared secret and cannot be reached from the internet.
 * A non-zero exit makes a silent failure visible as a failed Render run.
 *
 * The job declares its own runtime before anything can import config, which
 * validates the whole API env schema at import time. Relying on the scheduler
 * to set BYTSPOT_RUNTIME would make the job fail on a dashboard mistake and
 * would tempt someone to give it the API's request-signing secret instead.
 */
process.env.BYTSPOT_RUNTIME = 'job';

async function main(): Promise<void> {
  const { purgeExpiredAccounts } = await import('../services/accountDeletion');
  const { sweepDetachedCheckouts } = await import('../services/partyCheckoutSettlement');
  const { initErrorTracking } = await import('../lib/observability');
  const { config } = await import('../config');
  initErrorTracking();

  // Purging a host refunds their ticket sales first, so a run without Stripe
  // cannot settle anything: every refund would fail and every account would be
  // held. Refusing to start is the honest outcome, because a "successful" run
  // that returned nobody's money is worse than a visibly failed one.
  if (!config.stripeSecretKey) throw new Error('Purge job cannot settle refunds without STRIPE_SECRET_KEY.');

  const { purged, heldForOwedMoney } = await purgeExpiredAccounts();
  console.log(`[purge-accounts] purged ${purged} account(s), held ${heldForOwedMoney} with an unsettled payment`);

  // Runs in the same process as the purge that detaches these rows. The HTTP
  // route is not what the schedule calls, so leaving the sweep only there
  // meant it never ran in production.
  const detached = await sweepDetachedCheckouts();
  console.log(`[purge-accounts] detached ledger: refunded ${detached.refunded}, failed ${detached.failed}, needs review ${detached.needsReview}`);
}

async function disconnect(): Promise<void> {
  const { db } = await import('../lib/db');
  await db.$disconnect().catch(() => {});
}

main()
  .then(async () => {
    await disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[purge-accounts] failed', err);
    const { captureError } = await import('../lib/observability');
    captureError(err, { job: 'purge-accounts' });
    await disconnect();
    process.exit(1);
  });
