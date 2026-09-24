-- When a business first met every requirement for going live. Stamped once, so
-- a later suspension and reinstatement does not re-verify it.
ALTER TABLE "vendor_sellers" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP(3);

-- A business already live was verified by the same rule; stamping it here keeps
-- it from receiving a "you are verified" email on its next page load.
UPDATE "vendor_sellers" SET "verified_at" = "updated_at"
WHERE "verified_at" IS NULL AND "state" IN ('ACTIVE', 'SUSPENDED');
