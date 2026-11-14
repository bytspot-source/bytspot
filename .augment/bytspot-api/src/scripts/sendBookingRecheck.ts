/**
 * Weekly: email the admin inbox the booking links that guests no longer see,
 * or will stop seeing within 14 days, so someone opens and re-saves them.
 *
 * Runs against the database directly, like the other jobs. Sends nothing when
 * nothing is due. A non-zero exit makes a failure visible as a failed Render run.
 */
export {};

process.env.BYTSPOT_RUNTIME = 'job';

async function main(): Promise<void> {
  const { config } = await import('../config');
  const { bookingLinksToRecheck } = await import('../services/bookingRecheck');
  const { sendBookingRecheckEmail } = await import('../lib/email');
  const { initErrorTracking } = await import('../lib/observability');
  initErrorTracking();
  const to = config.safetyAlertEmail;
  if (!to) {
    console.log('[booking-recheck] SAFETY_ALERT_EMAIL is not set; nothing sent');
    return;
  }
  const items = await bookingLinksToRecheck();
  if (!items.length) {
    console.log('[booking-recheck] nothing to re-check');
    return;
  }
  await sendBookingRecheckEmail(to, items, 'https://bytspot.app/admin');
  console.log(`[booking-recheck] sent ${items.length} link(s) to re-check`);
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
    console.error('[booking-recheck] failed', err);
    const { captureError } = await import('../lib/observability');
    captureError(err, { job: 'booking-recheck' });
    await disconnect();
    process.exit(1);
  });
