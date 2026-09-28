-- What a business said it is, and the bookable types it added on top. Null kind: not asked yet.
ALTER TABLE "vendor_sellers" ADD COLUMN IF NOT EXISTS "business_kind" TEXT;
ALTER TABLE "vendor_sellers" ADD COLUMN IF NOT EXISTS "extra_bookable_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
