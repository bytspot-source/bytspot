-- Private sales: payment handles, sales with an expiring meet point, and buyer
-- requests. New tables only.
-- CreateTable
CREATE TABLE "seller_payment_handles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_payment_handles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_sales" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "providers" TEXT[],
    "meet_place_name" TEXT,
    "meet_lat" DOUBLE PRECISION,
    "meet_lng" DOUBLE PRECISION,
    "meet_area_label" TEXT,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "buyer_limit" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closed_at" TIMESTAMP(3),
    "meet_scrubbed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_sale_requests" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMP(3),
    "arrived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_sale_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_payment_handles_user_id_provider_key" ON "seller_payment_handles"("user_id", "provider");

-- CreateIndex
CREATE INDEX "private_sales_seller_id_status_idx" ON "private_sales"("seller_id", "status");

-- CreateIndex
CREATE INDEX "private_sales_status_window_end_idx" ON "private_sales"("status", "window_end");

-- CreateIndex
CREATE INDEX "private_sale_requests_buyer_id_idx" ON "private_sale_requests"("buyer_id");

-- CreateIndex
CREATE UNIQUE INDEX "private_sale_requests_sale_id_buyer_id_key" ON "private_sale_requests"("sale_id", "buyer_id");

-- AddForeignKey
ALTER TABLE "seller_payment_handles" ADD CONSTRAINT "seller_payment_handles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_sales" ADD CONSTRAINT "private_sales_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_sale_requests" ADD CONSTRAINT "private_sale_requests_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "private_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_sale_requests" ADD CONSTRAINT "private_sale_requests_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

