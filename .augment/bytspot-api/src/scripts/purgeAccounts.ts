import { purgeExpiredAccounts } from '../services/accountDeletion';
import { captureError, initErrorTracking } from '../lib/observability';
import { db } from '../lib/db';

/**
 * Scheduled entry point for the deletion promise.
 *
 * Runs against the database directly rather than calling the HTTP endpoint, so
 * the schedule needs no shared secret and cannot be reached from the internet.
 * A non-zero exit makes a silent failure visible as a failed Render run.
 */
async function main(): Promise<void> {
  initErrorTracking();
  const { purged } = await purgeExpiredAccounts();
  console.log(`[purge-accounts] purged ${purged} account(s)`);
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[purge-accounts] failed', err);
    captureError(err, { job: 'purge-accounts' });
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
