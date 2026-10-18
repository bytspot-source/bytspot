-- Where a place reference is, resolved by the server from Google at attach time.
-- Read as a destination for 30 days only; the place id stays the durable identity.
ALTER TABLE "plan_items" ADD COLUMN "place_name" TEXT;
ALTER TABLE "plan_items" ADD COLUMN "place_address" TEXT;
ALTER TABLE "plan_items" ADD COLUMN "place_lat" DOUBLE PRECISION;
ALTER TABLE "plan_items" ADD COLUMN "place_lng" DOUBLE PRECISION;
ALTER TABLE "plan_items" ADD COLUMN "place_resolved_at" TIMESTAMP(3);
