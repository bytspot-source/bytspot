-- Bytspot wristbands, assigned to a business by an admin and activated by that business.
-- CreateTable
CREATE TABLE "vendor_bands" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "location_id" TEXT,
    "tier" TEXT,
    "vendor_code" TEXT,
    "state" TEXT NOT NULL DEFAULT 'assigned',
    "assigned_by_user_id" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3),
    "activated_by_seat_id" TEXT,
    "lost_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_bands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bands_serial_key" ON "vendor_bands"("serial");

-- CreateIndex
CREATE INDEX "vendor_bands_seller_id_state_idx" ON "vendor_bands"("seller_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bands_seller_id_vendor_code_key" ON "vendor_bands"("seller_id", "vendor_code");

-- AddForeignKey
ALTER TABLE "vendor_bands" ADD CONSTRAINT "vendor_bands_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bands" ADD CONSTRAINT "vendor_bands_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "vendor_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

