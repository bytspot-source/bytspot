-- Admin decisions about a business: pause (with an optional reason shown to
-- the business), close for good, and who created it from admin. All nullable,
-- so every existing business reads as never paused, never closed by an admin.
ALTER TABLE "vendor_sellers" ADD COLUMN "paused_at" TIMESTAMP(3);
ALTER TABLE "vendor_sellers" ADD COLUMN "paused_by_user_id" TEXT;
ALTER TABLE "vendor_sellers" ADD COLUMN "paused_reason" TEXT;
ALTER TABLE "vendor_sellers" ADD COLUMN "closed_at" TIMESTAMP(3);
ALTER TABLE "vendor_sellers" ADD COLUMN "closed_by_user_id" TEXT;
ALTER TABLE "vendor_sellers" ADD COLUMN "created_by_user_id" TEXT;

ALTER TABLE "vendor_sellers" ADD CONSTRAINT "vendor_sellers_paused_reason_check" CHECK ("paused_reason" IS NULL OR char_length("paused_reason") <= 500);
