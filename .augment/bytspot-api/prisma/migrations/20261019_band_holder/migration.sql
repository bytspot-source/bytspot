-- The guest wearing a band, linked at the door from their paid ticket.
-- AlterTable
ALTER TABLE "vendor_bands" ADD COLUMN IF NOT EXISTS "holder_user_id" TEXT,
ADD COLUMN IF NOT EXISTS "linked_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "linked_by_seat_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vendor_bands_seller_id_holder_user_id_idx" ON "vendor_bands"("seller_id", "holder_user_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "vendor_bands" ADD CONSTRAINT "vendor_bands_holder_user_id_fkey" FOREIGN KEY ("holder_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
