CREATE TYPE "VendorServiceTier" AS ENUM ('SIMPLE', 'GREEN', 'PLATINUM', 'BLACK');

CREATE TYPE "VendorBookingRequestStatus" AS ENUM (
  'REQUESTED',
  'HOLD_AUTHORIZED',
  'ACCEPTED',
  'DECLINED',
  'COUNTER_OFFERED',
  'EXPIRED',
  'CANCELLED',
  'COMPLETED'
);

ALTER TABLE "vendor_services"
  ADD COLUMN "tier" "VendorServiceTier" NOT NULL DEFAULT 'SIMPLE';

ALTER TABLE "bookings"
  ADD COLUMN "tier" "VendorServiceTier" NOT NULL DEFAULT 'SIMPLE',
  ADD COLUMN "request_status" "VendorBookingRequestStatus" NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN "request_expires_at" TIMESTAMP(3),
  ADD COLUMN "accepted_at" TIMESTAMP(3),
  ADD COLUMN "declined_at" TIMESTAMP(3),
  ADD COLUMN "counter_offer_cents" INTEGER,
  ADD COLUMN "counter_offer_currency" TEXT,
  ADD COLUMN "counter_offer_message" TEXT,
  ADD COLUMN "guest_notes" TEXT,
  ADD COLUMN "logistics_mode" TEXT;

CREATE TABLE "vendor_notifications" (
  "id" TEXT NOT NULL,
  "vendor_id" TEXT NOT NULL,
  "booking_id" TEXT,
  "recipient_user_id" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "payload" JSONB,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vendor_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vendor_services_vendor_id_tier_idx" ON "vendor_services"("vendor_id", "tier");
CREATE INDEX "bookings_vendor_id_request_status_idx" ON "bookings"("vendor_id", "request_status");
CREATE INDEX "bookings_vendor_id_tier_idx" ON "bookings"("vendor_id", "tier");
CREATE INDEX "bookings_request_expires_at_idx" ON "bookings"("request_expires_at");
CREATE INDEX "vendor_notifications_vendor_id_read_at_created_at_idx" ON "vendor_notifications"("vendor_id", "read_at", "created_at" DESC);
CREATE INDEX "vendor_notifications_vendor_id_type_created_at_idx" ON "vendor_notifications"("vendor_id", "type", "created_at" DESC);
CREATE INDEX "vendor_notifications_booking_id_idx" ON "vendor_notifications"("booking_id");
CREATE INDEX "vendor_notifications_recipient_user_id_read_at_created_at_idx" ON "vendor_notifications"("recipient_user_id", "read_at", "created_at" DESC);

ALTER TABLE "vendor_notifications"
  ADD CONSTRAINT "vendor_notifications_vendor_id_fkey"
  FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vendor_notifications"
  ADD CONSTRAINT "vendor_notifications_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vendor_notifications"
  ADD CONSTRAINT "vendor_notifications_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;