-- A booking is shown at the door with a pass code and then checked in or
-- marked as a no-show. The code is issued when the guest accepts.
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "pass_code" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "checked_in_at" TIMESTAMP(3);
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "checked_in_by_seat_id" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "no_show_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "offers_pass_code_key" ON "offers"("pass_code");

-- Bookings accepted before this migration get a code too, so every guest
-- holding one can be checked in.
UPDATE "offers"
SET "pass_code" = UPPER(SUBSTRING(MD5("id" || RANDOM()::TEXT) FROM 1 FOR 8))
WHERE "state" = 'ACCEPTED' AND "pass_code" IS NULL;

-- Checked in and no-show are exclusive.
DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_attendance_exclusive"
    CHECK ("checked_in_at" IS NULL OR "no_show_at" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
