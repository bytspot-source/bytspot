-- Production already has a legacy Party table created before this Prisma
-- migration was introduced. Reconcile it without losing existing Party rows;
-- fresh databases still receive the complete target schema.
DO $$
BEGIN
  IF to_regclass('public.parties') IS NULL THEN
    CREATE TABLE "parties" (
      "id" TEXT NOT NULL,
      "host_user_id" TEXT NOT NULL,
      "idempotency_key" TEXT NOT NULL,
      "template_id" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "tagline" TEXT NOT NULL,
      "starts_at" TIMESTAMP(3) NOT NULL,
      "venue_name" TEXT NOT NULL,
      "capacity" INTEGER NOT NULL,
      "access_mode" TEXT NOT NULL,
      "required_membership_tier" TEXT NOT NULL,
      "audience_circle_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "itinerary" JSONB NOT NULL,
      "ticket_tiers" JSONB NOT NULL,
      "cohosts" JSONB NOT NULL,
      "template_config" JSONB NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'draft',
      "pass_code" TEXT,
      "published_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "parties_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "parties_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'parties' AND column_name = 'host_id')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'parties' AND column_name = 'host_user_id') THEN
    ALTER TABLE "parties" RENAME COLUMN "host_id" TO "host_user_id";
  END IF;
END $$;

ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "template_config" JSONB;
UPDATE "parties" SET "template_config" = '{"kind":"standard"}'::JSONB WHERE "template_config" IS NULL;
ALTER TABLE "parties" ALTER COLUMN "template_config" SET NOT NULL;
ALTER TABLE "parties" ALTER COLUMN "template_config" DROP DEFAULT;

DO $$
BEGIN
  IF to_regclass('public.parties_host_id_idempotency_key_key') IS NOT NULL
    AND to_regclass('public.parties_host_user_id_idempotency_key_key') IS NULL THEN
    ALTER INDEX "parties_host_id_idempotency_key_key" RENAME TO "parties_host_user_id_idempotency_key_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "parties_host_user_id_idempotency_key_key" ON "parties"("host_user_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "parties_pass_code_key" ON "parties"("pass_code");
CREATE INDEX IF NOT EXISTS "parties_host_user_id_status_idx" ON "parties"("host_user_id", "status");
CREATE INDEX IF NOT EXISTS "parties_status_starts_at_idx" ON "parties"("status", "starts_at");

CREATE TABLE IF NOT EXISTS "party_media" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "mime_type" TEXT NOT NULL,
  "bytes" BYTEA NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_media_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_media_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "party_media_party_id_kind_position_key" ON "party_media"("party_id", "kind", "position");
CREATE INDEX IF NOT EXISTS "party_media_party_id_idx" ON "party_media"("party_id");

-- These fields were added to the Prisma Venue model before a migration was
-- committed, so production databases need the same reconciliation.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "entry_type" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "entry_price" TEXT;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "ticket_url" TEXT;