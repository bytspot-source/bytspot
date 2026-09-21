-- CreateEnum
CREATE TYPE "VendorMediaKind" AS ENUM ('cover', 'gallery', 'video', 'menu');

-- CreateTable
CREATE TABLE "vendor_media" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "location_id" TEXT,
    "bookable_id" TEXT,
    "kind" "VendorMediaKind" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "mime_type" TEXT NOT NULL,
    "bytes" BYTEA,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_media_pkey" PRIMARY KEY ("id")
);

-- A file hangs off a place or a window, never both and never neither.
ALTER TABLE "vendor_media"
ADD CONSTRAINT "vendor_media_one_parent"
CHECK ((("location_id" IS NOT NULL)::int + ("bookable_id" IS NOT NULL)::int) = 1);

-- Bytes live in Postgres until object storage is configured; then storage_key
-- is the object and bytes is cleared. Never neither.
ALTER TABLE "vendor_media"
ADD CONSTRAINT "vendor_media_blob_present"
CHECK (("bytes" IS NOT NULL) OR ("storage_key" IS NOT NULL));

-- CreateIndex
CREATE UNIQUE INDEX "vendor_media_location_id_kind_position_key" ON "vendor_media"("location_id", "kind", "position");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_media_bookable_id_kind_position_key" ON "vendor_media"("bookable_id", "kind", "position");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_media_storage_key_key" ON "vendor_media"("storage_key");

-- CreateIndex
CREATE INDEX "vendor_media_seller_id_idx" ON "vendor_media"("seller_id");

-- CreateIndex
CREATE INDEX "vendor_media_location_id_idx" ON "vendor_media"("location_id");

-- CreateIndex
CREATE INDEX "vendor_media_bookable_id_idx" ON "vendor_media"("bookable_id");

-- AddForeignKey
ALTER TABLE "vendor_media" ADD CONSTRAINT "vendor_media_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_media" ADD CONSTRAINT "vendor_media_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "vendor_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The console's bookable id is the availability window this offering derives from.
ALTER TABLE "vendor_media" ADD CONSTRAINT "vendor_media_bookable_id_fkey" FOREIGN KEY ("bookable_id") REFERENCES "vendor_availability_windows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
