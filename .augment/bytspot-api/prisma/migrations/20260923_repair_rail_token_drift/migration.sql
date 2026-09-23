-- Some databases already held "demands" and "vendor_availability_windows" in
-- an earlier shape keyed by "rail_token" when 20260918 ran. Its
-- CREATE TABLE IF NOT EXISTS was a no-op there, so neither "category" nor
-- "domain" exists and every read of either model fails.
--
-- Each step checks the shape first. Where 20260918 created the tables this
-- migration changes nothing.

-- ─── demands.rail_token → demands.category ──────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'demands' AND column_name = 'rail_token')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'demands' AND column_name = 'category') THEN
    ALTER TABLE "demands" RENAME COLUMN "rail_token" TO "category";
  END IF;
END $$;

DROP INDEX IF EXISTS "demands_rail_token_state_latitude_longitude_idx";
CREATE INDEX IF NOT EXISTS "demands_category_state_latitude_longitude_idx"
  ON "demands" ("category", "state", "latitude", "longitude");

-- Not NOT VALID: a rail token left in a row is the defect 20260918 describes,
-- so a row carrying one has to stop this migration rather than survive it.
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_category_known"
    CHECK ("category" IN ('boutique_apartment', 'mobility', 'nightlife', 'dining', 'coffee',
                          'shopping', 'entertainment', 'service', 'fitness', 'parking', 'valet'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── vendor_availability_windows.rail_token → .domain ───────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'vendor_availability_windows' AND column_name = 'rail_token')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'vendor_availability_windows' AND column_name = 'domain') THEN
    ALTER TABLE "vendor_availability_windows" RENAME COLUMN "rail_token" TO "domain";
  END IF;
END $$;

DROP INDEX IF EXISTS "vendor_availability_windows_rail_token_active_idx";
CREATE INDEX IF NOT EXISTS "vendor_availability_windows_domain_active_idx"
  ON "vendor_availability_windows" ("domain", "active");

DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_domain_known"
    CHECK ("domain" IN ('dining', 'nightlife', 'wellness', 'automotive', 'stay', 'stall',
                        'green', 'coffee', 'shopping', 'events', 'fitness'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
