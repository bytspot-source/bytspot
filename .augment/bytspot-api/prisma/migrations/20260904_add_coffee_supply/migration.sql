-- Coffee is Phase 2's second real bookable. Additive: two new tables, one
-- new column on plan_items, no data rewrite. The `capability` on a coffee
-- item is `request` — a hold ask, not a payment — and the reservation
-- carries its own hold window so the DB decides when a hold is stale.
--
-- Every statement is guarded (IF EXISTS / IF NOT EXISTS / DO $$ BEGIN …
-- EXCEPTION duplicate_object) so a manual retry after a P3009 clears the
-- migration cleanly. Prisma runs the whole file in one transaction, so a
-- normal failure leaves nothing behind — the guards exist to make a
-- resolve --rolled-back + redeploy equally safe on any partial state.

CREATE TABLE IF NOT EXISTS "coffee_spots" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "name" TEXT NOT NULL,
    "area_label" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "hold_minutes" INTEGER NOT NULL DEFAULT 15,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coffee_spots_pkey" PRIMARY KEY ("id"),
    -- A hold window that is zero or negative would let a caller book instantly
    -- and never see the hold state. Twelve hours is the ceiling: anything
    -- longer stops being a hold and starts being a reservation.
    CONSTRAINT "coffee_spots_hold_minutes_check" CHECK ("hold_minutes" BETWEEN 1 AND 720)
);

CREATE TABLE IF NOT EXISTS "coffee_reservations" (
    "id" TEXT NOT NULL,
    "coffee_spot_id" TEXT NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "party_size" INTEGER NOT NULL,
    "requested_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "hold_expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coffee_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coffee_reservations_status_check" CHECK ("status" IN ('pending', 'confirmed', 'declined', 'cancelled', 'expired')),
    CONSTRAINT "coffee_reservations_party_size_check" CHECK ("party_size" BETWEEN 1 AND 8)
);

CREATE INDEX IF NOT EXISTS "coffee_spots_active_created_at_idx" ON "coffee_spots"("active", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "coffee_reservations_requested_by_user_id_idempotency_key_key" ON "coffee_reservations"("requested_by_user_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "coffee_reservations_coffee_spot_id_requested_for_idx" ON "coffee_reservations"("coffee_spot_id", "requested_for");
CREATE INDEX IF NOT EXISTS "coffee_reservations_requested_by_user_id_created_at_idx" ON "coffee_reservations"("requested_by_user_id", "created_at" DESC);

-- FK ADDs are wrapped so a retry does not fail on a name that already
-- exists. The FK definitions themselves are unchanged.
DO $$ BEGIN
  ALTER TABLE "coffee_spots" ADD CONSTRAINT "coffee_spots_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "coffee_reservations" ADD CONSTRAINT "coffee_reservations_coffee_spot_id_fkey" FOREIGN KEY ("coffee_spot_id") REFERENCES "coffee_spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "coffee_reservations" ADD CONSTRAINT "coffee_reservations_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- plan_items gains coffee_reservation_id, and the "no room, no promise"
-- check now considers both real supply kinds. A PlanItem still links to at
-- most one supply row: the single-supply CHECK enforces that at the DB.
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "coffee_reservation_id" TEXT;

-- The old CHECK is dropped only if the previous migration reached the
-- point of adding it. Any deployment path that skipped 20260903's tail
-- would otherwise fail here, and P3009-block every subsequent deploy.
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_no_room_no_promise_check";

-- Replace-in-place idiom: drop-if-exists before add lets a retry through
-- without depending on state left by a failed apply.
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_no_supply_no_promise_check";
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_no_supply_no_promise_check"
    CHECK ("party_id" IS NOT NULL OR "coffee_reservation_id" IS NOT NULL OR "capability" = 'details');
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_single_supply_check";
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_single_supply_check"
    CHECK (NOT ("party_id" IS NOT NULL AND "coffee_reservation_id" IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS "plan_items_coffee_reservation_id_key" ON "plan_items"("coffee_reservation_id");
DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_coffee_reservation_id_fkey"
      FOREIGN KEY ("coffee_reservation_id") REFERENCES "coffee_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The orphan-downgrade trigger already runs when party_id is nulled by the
-- FK's SET NULL. It now runs on coffee_reservation_id too, so an item that
-- lost either kind of supply row cannot keep advertising an affordance.
CREATE OR REPLACE FUNCTION downgrade_orphaned_plan_items() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.party_id IS NULL AND OLD.party_id IS NOT NULL AND NEW.capability <> 'details' THEN
    NEW.capability := 'details';
    NEW.status := 'cancelled';
  END IF;
  IF NEW.coffee_reservation_id IS NULL AND OLD.coffee_reservation_id IS NOT NULL AND NEW.capability <> 'details' THEN
    NEW.capability := 'details';
    NEW.status := 'cancelled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plan_items_downgrade_orphans ON plan_items;
CREATE TRIGGER plan_items_downgrade_orphans
BEFORE UPDATE OF party_id, coffee_reservation_id ON plan_items
FOR EACH ROW EXECUTE FUNCTION downgrade_orphaned_plan_items();
