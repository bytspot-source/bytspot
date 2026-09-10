-- Draft selections only: no reservations, guests, holds, or payment writes.
-- All columns are nullable; old create/attach rows and their constraints survive.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "bookable_creation_hash" TEXT;
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "coffee_spot_id" TEXT;
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "selection_key" TEXT;

-- NULL keys preserve legacy attach behavior; selected identities dedupe per Plan,
-- including cancelled history so a delayed request cannot resurrect a detach.
CREATE UNIQUE INDEX IF NOT EXISTS "plan_items_plan_id_selection_key_key"
    ON "plan_items"("plan_id", "selection_key");
CREATE INDEX IF NOT EXISTS "plan_items_coffee_spot_id_idx" ON "plan_items"("coffee_spot_id");
DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_coffee_spot_id_fkey"
    FOREIGN KEY ("coffee_spot_id") REFERENCES "coffee_spots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Keep the two-supply XOR and orphan trigger; the new XOR also covers spots.
-- Request capability describes an action, not a guaranteed hold. The existing
-- no-supply guard must recognize the unreserved spot as real referenced supply.
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_no_supply_no_promise_check";
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_no_supply_no_promise_check"
    CHECK ("party_id" IS NOT NULL OR "coffee_reservation_id" IS NOT NULL OR "coffee_spot_id" IS NOT NULL OR "capability" = 'details');
DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_selection_supply_check"
    CHECK (num_nonnulls("party_id", "coffee_reservation_id", "coffee_spot_id") <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_coffee_selection_details_check";
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_coffee_selection_request_check";
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_coffee_selection_request_check"
    CHECK ("coffee_spot_id" IS NULL OR (
      "capability" = 'request' AND "status" IN ('available', 'cancelled')
      AND "need_kind" = 'coffee' AND "bookable_id" IS NOT NULL
      AND "selection_key" IS NOT NULL AND "selection_key" = 'coffeeSpot:' || "coffee_spot_id"
    ));
-- Every picker identity has the common snapshot, including party selections
-- and coffee selections upgraded to reservations. Legacy NULL keys stay valid.
DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_selection_snapshot_check"
    CHECK ("selection_key" IS NULL OR "bookable_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
