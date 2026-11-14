-- When an event's booking link stops being shown (Eventbrite, DICE and the
-- like). Null means the link has no end. It only exists alongside a link.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "booking_expires_at" TIMESTAMP(3);
DO $$ BEGIN
  ALTER TABLE "venues" ADD CONSTRAINT "venues_booking_expiry_needs_link"
    CHECK ("booking_expires_at" IS NULL OR "booking_url" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
