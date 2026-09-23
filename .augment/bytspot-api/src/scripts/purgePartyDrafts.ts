/**
 * Scheduled sweep of abandoned Host Studio drafts.
 *
 * Runs against the database directly rather than calling the HTTP endpoint, so
 * the schedule needs no shared secret and cannot be reached from the internet.
 * A non-zero exit makes a silent failure visible as a failed Render run.
 *
 * The job declares its own runtime before anything can import config, which
 * validates the whole API env schema at import time.
 */
export {};

process.env.BYTSPOT_RUNTIME = 'job';

async function main(): Promise<void> {
  const { purgeAbandonedPartyDrafts } = await import('../services/abandonedDrafts');
  const { initErrorTracking } = await import('../lib/observability');
  initErrorTracking();
  const { purged } = await purgeAbandonedPartyDrafts();
  console.log(`[purge-party-drafts] purged ${purged} abandoned draft(s)`);
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
    console.error('[purge-party-drafts] failed', err);
    const { captureError } = await import('../lib/observability');
    captureError(err, { job: 'purge-party-drafts' });
    await disconnect();
    process.exit(1);
  });
