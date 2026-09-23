-- Reservable tables inside a Party.
--
-- A Party sold one thing: entry. A ticket tier is the gate fee, what it costs
-- to be in the room at all, and there was no way to also hold space inside
-- that room. A table is charged on top of the gate, never instead of it, so a
-- guest may hold a gate ticket, a table, or both.
--
-- These are stored tables, not derived ones. A vendor availability window
-- recurs across a horizon, so a slot has no identity until a row materialises
-- it against an instant — which is why `vendor_slot_commitments` is keyed
-- `(window_id, starts_at)`. A table is written down once and owns its own
-- id, so capacity lives on the row itself and is taken with a guarded
-- increment. Reusing the commitment table here would copy a mechanism without
-- copying the problem it solves.

CREATE TABLE IF NOT EXISTS "party_tables" (
  "id"                       TEXT NOT NULL,
  "party_id"                 TEXT NOT NULL,
  "name"                     TEXT NOT NULL,
  "starts_at"                TIMESTAMP(3) NOT NULL,
  "ends_at"                  TIMESTAMP(3) NOT NULL,
  "capacity"                 INTEGER NOT NULL,
  "committed"                INTEGER NOT NULL DEFAULT 0,
  "price_cents"              INTEGER NOT NULL DEFAULT 0,
  "required_membership_tier" TEXT,
  "position"                 INTEGER NOT NULL,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "party_tables_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "party_tables" ADD CONSTRAINT "party_tables_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A table that holds nobody is not a table.
DO $$ BEGIN
  ALTER TABLE "party_tables" ADD CONSTRAINT "party_tables_capacity_positive"
    CHECK ("capacity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The whole point of the guarded increment: a lost race cannot oversell a
-- table, because the database refuses the row that would.
DO $$ BEGIN
  ALTER TABLE "party_tables" ADD CONSTRAINT "party_tables_committed_within_capacity"
    CHECK ("committed" >= 0 AND "committed" <= "capacity");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Zero is a free table. Negative is a refund the wrong way round.
DO $$ BEGIN
  ALTER TABLE "party_tables" ADD CONSTRAINT "party_tables_price_not_negative"
    CHECK ("price_cents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "party_tables" ADD CONSTRAINT "party_tables_window_ordered"
    CHECK ("ends_at" > "starts_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "party_tables_party_id_position_key"
  ON "party_tables" ("party_id", "position");
CREATE INDEX IF NOT EXISTS "party_tables_party_id_starts_at_idx"
  ON "party_tables" ("party_id", "starts_at");

-- ─── The guest's table ─────────────────────────────────────────────────────
-- Nullable: null means the guest holds only a gate ticket, or the Party offers
-- no tables at all.
-- ON DELETE SET NULL: removing a table must not remove the guest or the
-- payment record attached to them, it must leave them visibly unseated.

ALTER TABLE "party_guests" ADD COLUMN IF NOT EXISTS "table_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "party_guests" ADD CONSTRAINT "party_guests_table_id_fkey"
    FOREIGN KEY ("table_id") REFERENCES "party_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "party_guests_table_id_idx"
  ON "party_guests" ("table_id");
