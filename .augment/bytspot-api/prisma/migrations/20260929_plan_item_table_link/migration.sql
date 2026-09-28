-- A reference item may name the Google place it points at, so a hand-checked
-- OpenTable or Resy link can follow it onto the Plan, and the guest may record
-- that they booked it there. That record is the guest's word, never a booking.
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "place_id" TEXT;
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "guest_booked_at" TIMESTAMP(3);
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "guest_booked_for" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_place_id_shape"
    CHECK ("place_id" IS NULL OR "place_id" ~ '^[A-Za-z0-9_-]{1,255}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A place is only a pointer for an item with no supply; supply names its own place.
DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_place_reference_only"
    CHECK ("place_id" IS NULL OR ("party_id" IS NULL AND "coffee_reservation_id" IS NULL
      AND "coffee_spot_id" IS NULL AND "offer_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The guest can only say they booked a place the item points at, and a time
-- only travels with that report.
DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_guest_booking_shape"
    CHECK (("guest_booked_at" IS NULL OR "place_id" IS NOT NULL)
      AND ("guest_booked_for" IS NULL OR "guest_booked_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
