-- Time-boxed sittings inside a Party.
--
-- A Party had exactly one door: everyone arrived against one capacity for one
-- window. A host running a 7pm and a 9pm seating had no way to say so, and no
-- way to sell the two separately.
--
-- These are stored sittings, not derived ones. A vendor availability window
-- recurs across a horizon, so a slot has no identity until a row materialises
-- it against an instant — which is why `vendor_slot_commitments` is keyed
-- `(window_id, starts_at)`. A session is written down once and owns its own
-- id, so capacity lives on the row itself and is taken with a guarded
-- increment. Reusing the commitment table here would copy a mechanism without
-- copying the problem it solves.

CREATE TABLE IF NOT EXISTS "party_sessions" (
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

  CONSTRAINT "party_sessions_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A sitting that holds nobody is not a sitting.
DO $$ BEGIN
  ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_capacity_positive"
    CHECK ("capacity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The whole point of the guarded increment: a lost race cannot oversell a
-- sitting, because the database refuses the row that would.
DO $$ BEGIN
  ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_committed_within_capacity"
    CHECK ("committed" >= 0 AND "committed" <= "capacity");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Zero is a free sitting. Negative is a refund the wrong way round.
DO $$ BEGIN
  ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_price_not_negative"
    CHECK ("price_cents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_window_ordered"
    CHECK ("ends_at" > "starts_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "party_sessions_party_id_position_key"
  ON "party_sessions" ("party_id", "position");
CREATE INDEX IF NOT EXISTS "party_sessions_party_id_starts_at_idx"
  ON "party_sessions" ("party_id", "starts_at");

-- ─── The guest's sitting ─────────────────────────────────────────────────────
-- Nullable, and stays null for every Party that ran before sessions existed.
-- ON DELETE SET NULL: removing a sitting must not remove the guest or the
-- payment record attached to them, it must leave them visibly unseated.

ALTER TABLE "party_guests" ADD COLUMN IF NOT EXISTS "session_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "party_guests" ADD CONSTRAINT "party_guests_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "party_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "party_guests_session_id_idx"
  ON "party_guests" ("session_id");
