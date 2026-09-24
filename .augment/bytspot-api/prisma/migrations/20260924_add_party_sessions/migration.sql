-- Bottles and a stretch of time, sold as one unit.
--
-- This replaces the earlier party_tables shape, which modelled a table as
-- seats bounded by the Party's own window. Both were wrong: a club sells a
-- table by its bottles and its hours, and an after-hours session runs past
-- the Party's end at a different address. Neither table shipped, so this is a
-- first migration rather than a correction of live rows.

CREATE TABLE "party_sessions" (
  "id"                       TEXT NOT NULL,
  "party_id"                 TEXT NOT NULL,
  "seller_id"                TEXT NOT NULL,
  "name"                     TEXT NOT NULL,
  "kind"                     TEXT NOT NULL DEFAULT 'table',
  "starts_at"                TIMESTAMP(3) NOT NULL,
  "ends_at"                  TIMESTAMP(3) NOT NULL,
  "venue_name"               TEXT,
  "lat"                      DOUBLE PRECISION,
  "lng"                      DOUBLE PRECISION,
  "bottle_count"             INTEGER NOT NULL,
  "bottle_terms"             TEXT NOT NULL,
  "price_cents"              INTEGER NOT NULL DEFAULT 0,
  "quantity"                 INTEGER NOT NULL DEFAULT 1,
  "committed"                INTEGER NOT NULL DEFAULT 0,
  "required_membership_tier" TEXT,
  "position"                 INTEGER NOT NULL,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_sessions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A vendor's inventory does not vanish because a seller row was tidied away.
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Units of this session, not seats. One table is one unit however many
-- people stand around it.
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_quantity_positive"
  CHECK ("quantity" > 0);

-- The guard that makes a lost race impossible rather than unlikely.
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_committed_within_quantity"
  CHECK ("committed" >= 0 AND "committed" <= "quantity");

ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_price_not_negative"
  CHECK ("price_cents" >= 0);

ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_bottles_not_negative"
  CHECK ("bottle_count" >= 0);

-- Two shapes and no third. `included` means price_cents is the whole number;
-- `minimum` means bottles are bought on top of it.
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_bottle_terms_known"
  CHECK ("bottle_terms" IN ('included', 'minimum'));

ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_kind_known"
  CHECK ("kind" IN ('table', 'after-hours'));

-- Its own window, ordered against itself and nothing else. There is
-- deliberately no constraint tying these hours to the Party's: one bounding
-- ends_at by the Party's end would refuse every after-hours session.
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_window_ordered"
  CHECK ("ends_at" > "starts_at");

-- A session states a place completely or not at all; half an address cannot
-- be put on a map.
ALTER TABLE "party_sessions" ADD CONSTRAINT "party_sessions_coordinates_paired"
  CHECK (("lat" IS NULL) = ("lng" IS NULL));

CREATE UNIQUE INDEX "party_sessions_party_id_position_key" ON "party_sessions"("party_id", "position");
CREATE INDEX "party_sessions_party_id_starts_at_idx" ON "party_sessions"("party_id", "starts_at");
CREATE INDEX "party_sessions_seller_id_starts_at_idx" ON "party_sessions"("seller_id", "starts_at");

-- ─── One guest holding one session ──────────────────────────────────────────
-- Kept off party_guests on purpose: admission and bottles are separate sales
-- made at different moments. Carried on the admission row, buying bottles
-- rewrote the pass and revoked entry the guest had already paid for.

CREATE TABLE "party_session_claims" (
  "id"         TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "party_id"   TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "state"      TEXT NOT NULL DEFAULT 'held',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_session_claims_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "party_session_claims" ADD CONSTRAINT "party_session_claims_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "party_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "party_session_claims" ADD CONSTRAINT "party_session_claims_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "party_session_claims" ADD CONSTRAINT "party_session_claims_state_known"
  CHECK ("state" IN ('held', 'released'));

CREATE INDEX "party_session_claims_party_id_user_id_idx" ON "party_session_claims"("party_id", "user_id");
CREATE INDEX "party_session_claims_session_id_state_idx" ON "party_session_claims"("session_id", "state");

-- ─── Checkout pays for a session, and may pay for nothing else ──────────────

-- A guest who is already inside and buys only bottles names no tier, so the
-- gate stops being mandatory on a checkout row.
ALTER TABLE "party_checkouts" ALTER COLUMN "ticket_tier_name" DROP NOT NULL;

ALTER TABLE "party_checkouts" ADD COLUMN "session_id" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN "session_amount_cents" INTEGER NOT NULL DEFAULT 0;

-- A settled session must survive its checkout being cleaned up, or a guest
-- holding bottles would quietly stop holding them.
ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "party_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_session_amount_not_negative"
  CHECK ("session_amount_cents" >= 0);

-- Money for a session requires a session to have bought.
ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_session_amount_needs_session"
  CHECK ("session_amount_cents" = 0 OR "session_id" IS NOT NULL);

-- A checkout buys something: a gate ticket, a session, or both.
ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_buys_something"
  CHECK ("ticket_tier_name" IS NOT NULL OR "session_id" IS NOT NULL);

CREATE INDEX "party_checkouts_session_id_status_reservation_expires_at_idx"
  ON "party_checkouts"("session_id", "status", "reservation_expires_at");
