-- A printed QR code or NFC tag that opens one place, or one service there.
-- A partner patch is the same link handed to a business that sends guests.
CREATE TABLE IF NOT EXISTS "vendor_patches" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "window_id" TEXT,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'patch',
    "label" TEXT NOT NULL,
    "partner_name" TEXT,
    "scans" INTEGER NOT NULL DEFAULT 0,
    "last_scanned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_seat_id" TEXT,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "vendor_patches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vendor_patches_kind_check" CHECK ("kind" IN ('patch', 'partner')),
    CONSTRAINT "vendor_patches_partner_named_check" CHECK ("kind" <> 'partner' OR "partner_name" IS NOT NULL),
    CONSTRAINT "vendor_patches_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "vendor_patches_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "vendor_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "vendor_patches_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "vendor_availability_windows"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_patches_code_key" ON "vendor_patches"("code");
CREATE INDEX IF NOT EXISTS "vendor_patches_seller_id_kind_idx" ON "vendor_patches"("seller_id", "kind");

ALTER TABLE "demands" ADD COLUMN IF NOT EXISTS "via_patch_id" TEXT;
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_via_patch_id_fkey"
    FOREIGN KEY ("via_patch_id") REFERENCES "vendor_patches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "demands_via_patch_id_idx" ON "demands"("via_patch_id");
