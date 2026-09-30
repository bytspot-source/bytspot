-- A Bytspot admin lists a place with its hand-checked OpenTable or Resy link.
-- The link lives on the venue, so a listed place is also a venue guests can
-- check in to. This replaces the checked-in table-booking-links.json.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "booking_provider" TEXT;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "booking_url" TEXT;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "booking_checked_at" TIMESTAMP(3);
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "listed_at" TIMESTAMP(3);
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "listed_by_user_id" TEXT;

-- Provider, URL and the date it was checked travel together, only on https,
-- and only on a venue keyed by a Google place.
DO $$ BEGIN
  ALTER TABLE "venues" ADD CONSTRAINT "venues_booking_link_shape"
    CHECK (
      ("booking_provider" IS NULL AND "booking_url" IS NULL AND "booking_checked_at" IS NULL)
      OR ("booking_provider" IN ('opentable', 'resy') AND "booking_url" ~ '^https://'
          AND "booking_checked_at" IS NOT NULL AND "google_place_id" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per tap on a listed place's booking link: the count an admin shows a
-- restaurant when pitching it. The guest is kept only while their account is.
CREATE TABLE IF NOT EXISTS "booking_link_taps" (
  "id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "user_id" TEXT,
  "surface" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_link_taps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "booking_link_taps_surface" CHECK ("surface" IN ('venue', 'plan'))
);
CREATE INDEX IF NOT EXISTS "booking_link_taps_venue_id_created_at_idx" ON "booking_link_taps" ("venue_id", "created_at");
DO $$ BEGIN
  ALTER TABLE "booking_link_taps" ADD CONSTRAINT "booking_link_taps_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "booking_link_taps" ADD CONSTRAINT "booking_link_taps_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A business goes live only once a Bytspot admin approves it. Businesses that
-- are already live were approved by the old automatic rule, so they keep it.
ALTER TABLE "vendor_sellers" ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP(3);
ALTER TABLE "vendor_sellers" ADD COLUMN IF NOT EXISTS "approved_by_user_id" TEXT;
UPDATE "vendor_sellers"
  SET "approved_at" = COALESCE("verified_at", "updated_at")
  WHERE "approved_at" IS NULL AND "state" IN ('ACTIVE', 'SUSPENDED');
