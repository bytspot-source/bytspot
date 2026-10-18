/**
 * Scheduled reminders and feedback prompts, every five minutes.
 *
 * Runs against the database directly rather than calling the HTTP endpoint, so
 * the schedule needs no shared secret and cannot be reached from the internet.
 * Repeating a run is harmless: each push is claimed once per member.
 *
 * The job declares its own runtime before anything can import config, which
 * validates the whole API env schema at import time.
 */
export {};

process.env.BYTSPOT_RUNTIME = 'job';

async function main(): Promise<void> {
  const { sendUpcomingReminders } = await import('../services/scheduledPushes');
  const { initErrorTracking } = await import('../lib/observability');
  initErrorTracking();
  const result = await sendUpcomingReminders(new Date());
  console.log(`[reminders] party ${result.partyReminders}, plan ${result.planReminders}, feedback ${result.feedbackRequests}`);
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
    console.error('[reminders] failed', err);
    const { captureError } = await import('../lib/observability');
    captureError(err, { job: 'reminders' });
    await disconnect();
    process.exit(1);
  });
