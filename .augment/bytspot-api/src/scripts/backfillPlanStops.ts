/**
 * Fill PlanItem.venueId and arrivesAt where supply already states them.
 *
 * Not part of migrate deploy and not run at process start. Production, a
 * Render host, and any database on render.com are refused. Counts are the
 * only thing printed.
 *
 *   BYTSPOT_BACKFILL_PLAN_STOPS=1 npx tsx src/scripts/backfillPlanStops.ts --dry-run
 *   BYTSPOT_BACKFILL_PLAN_STOPS=1 npx tsx src/scripts/backfillPlanStops.ts
 */
export {};

process.env.BYTSPOT_RUNTIME = 'job';

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'plan-stop backfill failed';
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://***');
}

async function main(): Promise<void> {
  const { assertBackfillAllowed, backfillPlanStops, planStopStore } = await import('../services/planStops');
  assertBackfillAllowed(process.env);
  const dryRun = process.argv.includes('--dry-run');
  const { db } = await import('../lib/db');
  try {
    const report = await backfillPlanStops(planStopStore(db), { dryRun });
    console.log(JSON.stringify({ dryRun, ...report }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(safeMessage(error));
  process.exit(1);
});
