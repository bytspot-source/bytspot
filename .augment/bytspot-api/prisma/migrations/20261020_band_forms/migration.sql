-- Five kinds of NFC item share the band's rules; cards and event fobs unlink by themselves.
-- AlterTable
ALTER TABLE "vendor_bands" ADD COLUMN IF NOT EXISTS "form" TEXT NOT NULL DEFAULT 'band',
ADD COLUMN IF NOT EXISTS "linked_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "vendor_band_visits" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "band_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seat_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_band_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vendor_band_visits_seller_id_user_id_created_at_idx" ON "vendor_band_visits"("seller_id", "user_id", "created_at");
CREATE INDEX IF NOT EXISTS "vendor_band_visits_band_id_created_at_idx" ON "vendor_band_visits"("band_id", "created_at");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "vendor_band_visits" ADD CONSTRAINT "vendor_band_visits_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_band_visits" ADD CONSTRAINT "vendor_band_visits_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "vendor_bands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_band_visits" ADD CONSTRAINT "vendor_band_visits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
