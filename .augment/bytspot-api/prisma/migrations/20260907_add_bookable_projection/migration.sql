-- Bookable is a projection handle over attached supply: the honest snapshot a
-- Plan item (and, later, the booking spine) reads from. Additive and nullable
-- so it is safe on a table that already holds plan_items. `control` is never a
-- column — it is derived from `capability` — so the table cannot contradict the
-- trust gate. Upstream ids live only in `fulfillment`, never in the BYT- id.
CREATE TABLE IF NOT EXISTS "bookables" (
    "id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "provider" TEXT,
    "tier_name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "membership_floor" TEXT,
    "fulfillment" JSONB NOT NULL DEFAULT '{}',
    "snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookables_pkey" PRIMARY KEY ("id")
);

-- plan_items gains a nullable pointer to its projection handle. It is a pure
-- denormalization: it does not join the single-supply XOR and carries no
-- promise the item's own capability does not already hold.
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "bookable_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "plan_items_bookable_id_key" ON "plan_items"("bookable_id");

DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_bookable_id_fkey"
      FOREIGN KEY ("bookable_id") REFERENCES "bookables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A Bookable is a per-item snapshot with no life of its own, so when its
-- plan_item row is removed (only ever via a Plan cascade-delete — detach merely
-- cancels) the projection row goes with it. Mirrors the existing plan_items
-- orphan-trigger idiom so no dangling snapshots accumulate.
CREATE OR REPLACE FUNCTION delete_orphaned_bookable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.bookable_id IS NOT NULL THEN
    DELETE FROM "bookables" WHERE "id" = OLD.bookable_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plan_items_delete_bookable ON plan_items;
CREATE TRIGGER plan_items_delete_bookable
AFTER DELETE ON plan_items
FOR EACH ROW EXECUTE FUNCTION delete_orphaned_bookable();
