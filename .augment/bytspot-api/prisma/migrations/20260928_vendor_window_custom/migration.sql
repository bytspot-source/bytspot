-- A seller may name and time what they sell; a blank window has no template to borrow from.
ALTER TABLE "vendor_availability_windows" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "vendor_availability_windows" ADD COLUMN IF NOT EXISTS "duration_mins" INTEGER;

DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_title_shape"
    CHECK ("title" IS NULL OR char_length(btrim("title")) BETWEEN 1 AND 80);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_duration_range"
    CHECK ("duration_mins" IS NULL OR "duration_mins" BETWEEN 5 AND 1440);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A blank window cannot fall back to a catalog title, so it must carry its own.
DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_custom_named"
    CHECK ("sku_template_id" NOT LIKE 'custom.%' OR "title" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
