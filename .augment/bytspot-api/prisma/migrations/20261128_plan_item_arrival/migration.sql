-- Where a Plan expects to be, and when (Nash plan balancing, N1).
--
-- A Plan item already points at supply that sometimes knows both facts: a
-- party names its arrival venue and its start, a place item names a Google
-- place a Venue may share, a won offer names a start and maybe a menu venue,
-- and a guest may have said when they booked. Nothing on the row recorded the
-- answer, so every forecast had to re-derive it and still could not, because
-- a leg has a time and no venue id.
--
-- Both columns are nullable and have no default. A writer that has not heard
-- of them, and a stop that genuinely has no venue or no stated time (a coffee
-- hold has neither), leave NULL. NULL means unknown. It is not filled with
-- "now" or with a guessed venue.
--
-- This migration does not backfill. Filling rows is a separate script
-- (src/scripts/backfillPlanStops.ts) and must not run inside migrate deploy,
-- which is what production executes on the way up. Re-running the statements
-- below is a no-op.

ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "venue_id" TEXT;
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "arrives_at" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The read is "plans due at this venue between these instants".
--
-- Not CONCURRENTLY: Prisma wraps each migration in a transaction, which
-- forbids it. plan_items is still small enough that the lock is brief.
CREATE INDEX IF NOT EXISTS "plan_items_venue_id_arrives_at_idx"
  ON "plan_items" ("venue_id", "arrives_at");
