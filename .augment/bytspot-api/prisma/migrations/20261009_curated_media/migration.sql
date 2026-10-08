-- Bytspot-curated venue media, team approval for vendor media, and paid video
-- hosting for vendors. Vendor files already live stay approved; every new or
-- replaced file waits for the Bytspot team.
CREATE TABLE IF NOT EXISTS "venue_media" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "kind" "VendorMediaKind" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "mime_type" TEXT NOT NULL,
    "bytes" BYTEA,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT,
    "uploaded_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "venue_media_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "venue_media_kind_check" CHECK ("kind" IN ('cover', 'gallery', 'video')),
    CONSTRAINT "venue_media_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "venue_media_storage_key_key" ON "venue_media"("storage_key");
CREATE UNIQUE INDEX IF NOT EXISTS "venue_media_venue_id_kind_position_key" ON "venue_media"("venue_id", "kind", "position");
CREATE INDEX IF NOT EXISTS "venue_media_venue_id_idx" ON "venue_media"("venue_id");

DO $$ BEGIN
  ALTER TABLE "vendor_media" ADD COLUMN "review_status" TEXT NOT NULL DEFAULT 'approved';
  ALTER TABLE "vendor_media" ALTER COLUMN "review_status" SET DEFAULT 'pending';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
ALTER TABLE "vendor_media" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(3);
ALTER TABLE "vendor_media" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" TEXT;
ALTER TABLE "vendor_media" ADD COLUMN IF NOT EXISTS "review_note" TEXT;
DO $$ BEGIN
  ALTER TABLE "vendor_media" ADD CONSTRAINT "vendor_media_review_status_check"
    CHECK ("review_status" IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "vendor_media_review_status_created_at_idx" ON "vendor_media"("review_status", "created_at");

ALTER TABLE "vendor_sellers" ADD COLUMN IF NOT EXISTS "video_hosting_at" TIMESTAMP(3);
ALTER TABLE "vendor_sellers" ADD COLUMN IF NOT EXISTS "video_hosting_by_user_id" TEXT;
