-- A band, card or fob whose chip makes a fresh code on every tap is secured on its first valid tap.
-- AlterTable
ALTER TABLE "vendor_bands" ADD COLUMN IF NOT EXISTS "sun_uid" TEXT,
ADD COLUMN IF NOT EXISTS "sun_counter" INTEGER,
ADD COLUMN IF NOT EXISTS "secured_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "last_tap_at" TIMESTAMP(3);
