-- Bring the migration history back in line with schema.prisma.
--
-- Production was partly shaped by `prisma db push`, which changes the database
-- without recording a migration. The result: a database built from migrations
-- alone is missing pieces the code expects, and nothing noticed until CI began
-- applying migrations to an empty Postgres.
--
-- Every statement is written to be a no-op against production, which already
-- has all of this, and to do the real work on a fresh database.

-- Extensions are deliberately not touched here: 20260226 already enables
-- postgis and vector defensively, tolerating a Postgres that cannot host them.
-- The UserPreference model has no migration at all: the table has only ever
-- existed because db push created it.
CREATE TABLE IF NOT EXISTS "user_preferences" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "interests"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "vibes"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "cuisines"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "parking"    JSONB,
  "behavior"   JSONB,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_user_id_key" ON "user_preferences" ("user_id");

DO $$
BEGIN
  ALTER TABLE "user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 20260811 wrote this index name out in full; Postgres truncates identifiers at
-- 63 characters, so the stored name differs from the one Prisma derives.
ALTER INDEX IF EXISTS "party_checkouts_party_id_ticket_tier_name_status_reservation_ex"
  RENAME TO "party_checkouts_party_id_ticket_tier_name_status_reservatio_idx";
