-- A place's own phone and website, shown to guests as Call and Website.
ALTER TABLE "vendor_locations" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "vendor_locations" ADD COLUMN IF NOT EXISTS "website" TEXT;

-- Normalised on write: "+" and digits only, and an absolute http(s) URL.
DO $$ BEGIN
  ALTER TABLE "vendor_locations" ADD CONSTRAINT "vendor_locations_phone_shape"
    CHECK ("phone" IS NULL OR "phone" ~ '^\+?[0-9]{7,15}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_locations" ADD CONSTRAINT "vendor_locations_website_shape"
    CHECK ("website" IS NULL OR ("website" ~ '^https?://' AND length("website") <= 200));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An ask raised from one Discover card. Only that window's seller sees it; a
-- demand with no target is broadcast exactly as before.
ALTER TABLE "demands" ADD COLUMN IF NOT EXISTS "target_window_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_target_window_id_fkey"
    FOREIGN KEY ("target_window_id") REFERENCES "vendor_availability_windows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "demands_target_window_id_idx" ON "demands" ("target_window_id");
