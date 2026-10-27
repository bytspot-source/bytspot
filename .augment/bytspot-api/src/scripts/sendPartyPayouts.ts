/**
 * Scheduled party payouts: each sale's host and business shares, sent by
 * Stripe transfer once the party has been over for PARTY_PAYOUT_DELAY_HOURS.
 *
 * Runs against the database directly rather than calling the HTTP endpoint, so
 * the schedule needs no shared secret and cannot be reached from the internet.
 * Every transfer is claimed and keyed per sale and recipient, so an overlapping
 * or retried run sends nothing twice. Any payout, reversal or charge lookup
 * that failed exits non-zero, so the run shows as failed on Render; each new
 * problem is also sent to Sentry and PAYOUT_ALERT_EMAIL once.
 *
 * The job declares its own runtime before anything can import config, which
 * validates the whole API env schema at import time.
 */
export {};

process.env.BYTSPOT_RUNTIME = 'job';

/** True when every payout due this run went through or is waiting on its recipient. */
async function main(): Promise<boolean> {
  const { config } = await import('../config');
  if (!config.partyPayoutsEnabled || !config.stripeSecretKey) {
    console.log('[party-payouts] off; nothing sent');
    return true;
  }
  const { default: Stripe } = await import('stripe');
  const { runPartyPayouts } = await import('../services/partyPayouts');
  const { initErrorTracking } = await import('../lib/observability');
  initErrorTracking();
  const result = await runPartyPayouts({ stripe: new Stripe(config.stripeSecretKey) });
  console.log(`[party-payouts] paid ${result.paid}, held ${result.held}, failed ${result.failed}, waiting ${result.waiting}, reversed ${result.reversed}`);
  if (result.alerts.length === 0) return result.failed === 0;
  const { captureError } = await import('../lib/observability');
  captureError(new Error(`Party payouts need attention: ${result.alerts.length}`), { job: 'party-payouts', alerts: result.alerts.join(' | ').slice(0, 2000) });
  if (config.payoutAlertEmail) {
    const { sendPayoutAlertEmail } = await import('../lib/email');
    await sendPayoutAlertEmail(config.payoutAlertEmail, result.alerts).catch((err) => console.error('[party-payouts] alert email failed', err));
  } else {
    console.warn('[party-payouts] PAYOUT_ALERT_EMAIL is not set; problems went to Sentry only');
  }
  return result.failed === 0;
}

async function disconnect(): Promise<void> {
  const { db } = await import('../lib/db');
  await db.$disconnect().catch(() => {});
}

main()
  .then(async (ok) => {
    await disconnect();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('[party-payouts] failed', err);
    const { captureError } = await import('../lib/observability');
    captureError(err, { job: 'party-payouts' });
    await disconnect();
    process.exit(1);
  });
