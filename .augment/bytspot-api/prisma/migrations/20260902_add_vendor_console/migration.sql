-- CreateEnum
CREATE TYPE "VendorSellerState" AS ENUM ('DRAFT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "VendorBusinessMode" AS ENUM ('standard', 'cottage');

-- CreateEnum
CREATE TYPE "VendorSeatRole" AS ENUM ('owner', 'manager', 'staff', 'door', 'serviceProvider');

-- CreateEnum
CREATE TYPE "VendorSeatState" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "VendorLocationState" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "VendorPayoutStatus" AS ENUM ('pending', 'active', 'restricted');

-- CreateEnum
CREATE TYPE "VendorEndpointState" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

-- CreateTable
CREATE TABLE "vendor_sellers" (
    "id" TEXT NOT NULL,
    "legal_name" TEXT,
    "contact_email" TEXT,
    "state" "VendorSellerState" NOT NULL DEFAULT 'DRAFT',
    "business_mode" "VendorBusinessMode" NOT NULL DEFAULT 'standard',
    "payout_reference" TEXT,
    "payout_status" "VendorPayoutStatus",
    "payout_last4" TEXT,
    "payout_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_seats" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "VendorSeatRole" NOT NULL,
    "state" "VendorSeatState" NOT NULL DEFAULT 'INVITED',
    "location_ids" TEXT[],
    "bookable_ids" TEXT[],
    "invited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_locations" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" "VendorLocationState" NOT NULL DEFAULT 'DRAFT',
    "address" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radius_miles" DOUBLE PRECISION,
    "timezone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_webhook_endpoints" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "seat_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "scopes" TEXT[],
    "state" "VendorEndpointState" NOT NULL DEFAULT 'ACTIVE',
    "secret_encrypted" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_delivery_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_sellers_state_idx" ON "vendor_sellers"("state");

-- CreateIndex
CREATE INDEX "vendor_seats_user_id_state_idx" ON "vendor_seats"("user_id", "state");

-- CreateIndex
CREATE INDEX "vendor_seats_seller_id_state_idx" ON "vendor_seats"("seller_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_seats_seller_id_user_id_key" ON "vendor_seats"("seller_id", "user_id");

-- CreateIndex
CREATE INDEX "vendor_locations_seller_id_state_idx" ON "vendor_locations"("seller_id", "state");

-- CreateIndex
CREATE INDEX "vendor_webhook_endpoints_seller_id_idx" ON "vendor_webhook_endpoints"("seller_id");

-- CreateIndex
CREATE INDEX "vendor_webhook_endpoints_seat_id_idx" ON "vendor_webhook_endpoints"("seat_id");

-- CreateIndex
CREATE INDEX "vendor_webhook_deliveries_next_attempt_at_idx" ON "vendor_webhook_deliveries"("next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_webhook_deliveries_endpoint_id_event_id_key" ON "vendor_webhook_deliveries"("endpoint_id", "event_id");

-- AddForeignKey
ALTER TABLE "vendor_seats" ADD CONSTRAINT "vendor_seats_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_seats" ADD CONSTRAINT "vendor_seats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_locations" ADD CONSTRAINT "vendor_locations_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_webhook_endpoints" ADD CONSTRAINT "vendor_webhook_endpoints_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_webhook_endpoints" ADD CONSTRAINT "vendor_webhook_endpoints_seat_id_fkey" FOREIGN KEY ("seat_id") REFERENCES "vendor_seats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_webhook_deliveries" ADD CONSTRAINT "vendor_webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "vendor_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

