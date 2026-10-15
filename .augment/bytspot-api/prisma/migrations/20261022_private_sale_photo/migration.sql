-- A Private Sale can carry one item photo, shown on its share link.
-- CreateTable
CREATE TABLE "private_sale_photos" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_sale_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "private_sale_photos_sale_id_key" ON "private_sale_photos"("sale_id");

-- AddForeignKey
ALTER TABLE "private_sale_photos" ADD CONSTRAINT "private_sale_photos_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "private_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
