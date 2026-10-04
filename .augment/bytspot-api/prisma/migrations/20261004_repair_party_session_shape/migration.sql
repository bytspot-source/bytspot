-- Repair production databases stranded by the session-shape rewrite.
--
-- 20260923_add_party_sessions created the first party_sessions table. That
-- migration was later deleted and replaced by 20260924_add_party_sessions,
-- which creates the current table from scratch. Prisma treats the deleted
-- migration as already applied, so migrate deploy skips the replacement and
-- leaves the old table in place. This migration advances either shape to the
-- current contract without dropping a table or deleting a row.

CREATE TABLE IF NOT EXISTS "party_sessions" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "seller_id" TEXT,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'table',
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "venue_name" TEXT,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "bottle_count" INTEGER,
  "bottle_terms" TEXT,
  "price_cents" INTEGER NOT NULL DEFAULT 0,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "committed" INTEGER NOT NULL DEFAULT 0,
  "required_membership_tier" TEXT,
  "position" INTEGER NOT NULL,
  "withdrawn_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_sessions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "seller_id" TEXT;
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'table';
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "venue_name" TEXT;
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "lat" DOUBLE PRECISION;
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "lng" DOUBLE PRECISION;
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "bottle_count" INTEGER;
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "bottle_terms" TEXT;
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "withdrawn_at" TIMESTAMP(3);

-- Preserve old sitting capacity as one unit. Existing rows remain readable;
-- they cannot be newly sold until a seller and bottle terms are assigned.
UPDATE "party_sessions"
SET "quantity" = CASE WHEN "capacity" > 0 THEN 1 ELSE 1 END
WHERE "quantity" IS NULL AND EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'party_sessions' AND column_name = 'capacity'
);

ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_quantity_positive";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_committed_within_quantity";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_committed_within_quantity" CHECK ("committed" >= 0 AND "committed" <= "quantity");
ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_price_not_negative";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_price_not_negative" CHECK ("price_cents" >= 0);
ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_bottles_not_negative";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_bottles_not_negative" CHECK ("bottle_count" IS NULL OR "bottle_count" >= 0);
ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_bottle_terms_known";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_bottle_terms_known" CHECK ("bottle_terms" IS NULL OR "bottle_terms" IN ('included', 'minimum'));
ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_kind_known";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_kind_known" CHECK ("kind" IN ('table', 'after-hours'));
ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_window_ordered";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_window_ordered" CHECK ("ends_at" > "starts_at");
ALTER TABLE "party_sessions" DROP CONSTRAINT IF EXISTS "party_sessions_coordinates_paired";
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_coordinates_paired" CHECK (("lat" IS NULL) = ("lng" IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS "party_sessions_party_id_position_key" ON "party_sessions"("party_id", "position");
CREATE INDEX IF NOT EXISTS "party_sessions_party_id_withdrawn_at_idx" ON "party_sessions"("party_id", "withdrawn_at");
CREATE INDEX IF NOT EXISTS "party_sessions_party_id_starts_at_idx" ON "party_sessions"("party_id", "starts_at");
CREATE INDEX IF NOT EXISTS "party_sessions_seller_id_starts_at_idx" ON "party_sessions"("seller_id", "starts_at");

CREATE TABLE IF NOT EXISTS "party_session_claims" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'held',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_session_claims_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "session_id" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "session_amount_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "party_checkouts" DROP CONSTRAINT IF EXISTS "party_checkouts_session_amount_not_negative";
ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_session_amount_not_negative" CHECK ("session_amount_cents" >= 0);
CREATE INDEX IF NOT EXISTS "party_checkouts_session_id_status_reservation_expires_at_idx" ON "party_checkouts"("session_id", "status", "reservation_expires_at");
