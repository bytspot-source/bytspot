-- Demand, availability and offers: the spine that lets a consumer name a need
-- and a seller answer it with a real instance.
--
-- Nothing here grants a capability. A place with no window and no accepted
-- offer still renders as Listed, because capability is how far supply actually
-- reached, never a column someone remembered to set. The constraints below
-- exist to make the dishonest row unstorable rather than merely discouraged:
--
--   * a demand whose window runs backwards, or that expires before it is
--     raised, cannot exist;
--   * a party larger than the contract's ceiling, or a radius beyond its
--     maximum, cannot exist;
--   * an offer without a hold deadline cannot exist, because a hold without a
--     deadline is not a hold;
--   * slots are never stored, only the window that derives them and the
--     commitments taken against them, so capacity and state cannot disagree;
--   * demand_events rejects UPDATE and DELETE, because an append-only log that
--     can be rewritten is not evidence.
--
-- Plans gain two nullable columns and nothing else. A Plan without a budget is
-- still a Plan: it publishes demand the budget rule simply does not apply to.
--
-- Every statement is guarded (IF NOT EXISTS / DO $$ … EXCEPTION duplicate_object)
-- so a manual retry after a P3009 clears the migration cleanly.

-- ─── Plan: the two missing constraints ───────────────────────────────────────

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "budget_cents" INTEGER;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "radius_miles" DOUBLE PRECISION;

DO $$ BEGIN
  ALTER TABLE "plans" ADD CONSTRAINT "plans_budget_cents_positive"
    CHECK ("budget_cents" IS NULL OR "budget_cents" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "plans" ADD CONSTRAINT "plans_radius_miles_sane"
    CHECK ("radius_miles" IS NULL OR ("radius_miles" > 0 AND "radius_miles" <= 50));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Demand ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "demands" (
  "id"                TEXT NOT NULL,
  "plan_id"           TEXT,
  "raised_by_user_id" TEXT NOT NULL,
  "category"          TEXT NOT NULL,
  "state"             TEXT NOT NULL DEFAULT 'OPEN',
  "party_size"        INTEGER NOT NULL,
  "earliest"          TIMESTAMP(3) NOT NULL,
  "latest"            TIMESTAMP(3) NOT NULL,
  "latitude"          DOUBLE PRECISION NOT NULL,
  "longitude"         DOUBLE PRECISION NOT NULL,
  "radius_miles"      DOUBLE PRECISION NOT NULL,
  "budget_cents"      INTEGER,
  "note"              TEXT,
  "raised_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "demands_pkey" PRIMARY KEY ("id")
);

-- The contract's six states and nothing else.
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_state_known"
    CHECK ("state" IN ('OPEN', 'MATCHED', 'OFFERED', 'BOOKED', 'EXPIRED', 'WITHDRAWN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A discover category from the contract, never a Discover rail. Only these
-- carry domains, and the category match rule compares them against a seller's
-- domain; a rail token would make that rule unevaluable.
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_category_known"
    CHECK ("category" IN ('boutique_apartment', 'mobility', 'nightlife', 'dining', 'coffee',
                          'shopping', 'entertainment', 'service', 'fitness', 'parking', 'valet'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A window that runs backwards is not a window.
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_window_ordered"
    CHECK ("earliest" < "latest");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A need cannot expire before it was raised.
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_expiry_after_raise"
    CHECK ("expires_at" > "raised_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- demand.defaults.maxPartySize = 20.
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_party_size_bounded"
    CHECK ("party_size" >= 1 AND "party_size" <= 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- demand.defaults.maxRadiusMiles = 50.
DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_radius_bounded"
    CHECK ("radius_miles" > 0 AND "radius_miles" <= 50);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_budget_positive"
    CHECK ("budget_cents" IS NULL OR "budget_cents" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_coordinates_real"
    CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demands" ADD CONSTRAINT "demands_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "demands_state_expires_at_idx" ON "demands" ("state", "expires_at");
CREATE INDEX IF NOT EXISTS "demands_category_state_latitude_longitude_idx"
  ON "demands" ("category", "state", "latitude", "longitude");
CREATE INDEX IF NOT EXISTS "demands_plan_id_idx" ON "demands" ("plan_id");
CREATE INDEX IF NOT EXISTS "demands_raised_by_user_id_raised_at_idx"
  ON "demands" ("raised_by_user_id", "raised_at" DESC);

-- ─── Availability windows ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "vendor_availability_windows" (
  "id"              TEXT NOT NULL,
  "seller_id"       TEXT NOT NULL,
  "location_id"     TEXT NOT NULL,
  "sku_template_id" TEXT NOT NULL,
  "domain"          TEXT NOT NULL,
  "slot_kind"       TEXT NOT NULL DEFAULT 'rolling',
  "slot_minutes"    INTEGER NOT NULL DEFAULT 30,
  "lead_time_mins"  INTEGER NOT NULL DEFAULT 60,
  "horizon_days"    INTEGER NOT NULL DEFAULT 30,
  "weekdays"        INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "open_mins"       INTEGER NOT NULL,
  "close_mins"      INTEGER NOT NULL,
  "quantity"        INTEGER NOT NULL,
  "price_cents"     INTEGER NOT NULL,
  "max_guests"      INTEGER NOT NULL,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vendor_availability_windows_pkey" PRIMARY KEY ("id")
);

-- The seller's side of the category rule.
DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_domain_known"
    CHECK ("domain" IN ('dining', 'nightlife', 'wellness', 'automotive', 'stay', 'stall',
                        'green', 'coffee', 'shopping', 'events', 'fitness'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- availability.slotKinds.
DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_slot_kind_known"
    CHECK ("slot_kind" IN ('rolling', 'daily', 'fixed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A window that closes before it opens sells nothing; minutes are within a day.
DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_ordered"
    CHECK ("open_mins" >= 0 AND "close_mins" <= 1440 AND "open_mins" < "close_mins");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- availability.defaults.maxQuantityPerSlot = 999.
DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_quantity_bounded"
    CHECK ("quantity" >= 1 AND "quantity" <= 999);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_shape_sane"
    CHECK ("slot_minutes" > 0 AND "lead_time_mins" >= 0 AND "horizon_days" > 0
           AND "price_cents" >= 0 AND "max_guests" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_availability_windows_seller_id_fkey"
    FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_availability_windows_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "vendor_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "vendor_availability_windows_seller_id_active_idx"
  ON "vendor_availability_windows" ("seller_id", "active");
CREATE INDEX IF NOT EXISTS "vendor_availability_windows_domain_active_idx"
  ON "vendor_availability_windows" ("domain", "active");
CREATE INDEX IF NOT EXISTS "vendor_availability_windows_location_id_sku_template_id_idx"
  ON "vendor_availability_windows" ("location_id", "sku_template_id");

-- ─── Slot commitments ────────────────────────────────────────────────────────
--
-- Slots themselves are never stored. A row here is a fact taken against one
-- derived instant; an untouched slot is fully open by the absence of a row.

CREATE TABLE IF NOT EXISTS "vendor_slot_commitments" (
  "id"           TEXT NOT NULL,
  "window_id"    TEXT NOT NULL,
  "starts_at"    TIMESTAMP(3) NOT NULL,
  "committed"    INTEGER NOT NULL DEFAULT 0,
  "blocked"      BOOLEAN NOT NULL DEFAULT false,
  "closed"       BOOLEAN NOT NULL DEFAULT false,
  "block_reason" TEXT,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vendor_slot_commitments_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "vendor_slot_commitments" ADD CONSTRAINT "vendor_slot_commitments_committed_not_negative"
    CHECK ("committed" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A block without a reason is an outage nobody can explain.
DO $$ BEGIN
  ALTER TABLE "vendor_slot_commitments" ADD CONSTRAINT "vendor_slot_commitments_block_explained"
    CHECK ("blocked" = false OR "block_reason" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- availability.blockReasons. A reason outside the vocabulary cannot be shown
-- to a guest, so it cannot be stored.
DO $$ BEGIN
  ALTER TABLE "vendor_slot_commitments" ADD CONSTRAINT "vendor_slot_commitments_block_reason_known"
    CHECK ("block_reason" IS NULL
           OR "block_reason" IN ('holiday', 'maintenance', 'private-event', 'staffing', 'weather'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_slot_commitments" ADD CONSTRAINT "vendor_slot_commitments_window_id_fkey"
    FOREIGN KEY ("window_id") REFERENCES "vendor_availability_windows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_slot_commitments_window_id_starts_at_key"
  ON "vendor_slot_commitments" ("window_id", "starts_at");
CREATE INDEX IF NOT EXISTS "vendor_slot_commitments_starts_at_idx"
  ON "vendor_slot_commitments" ("starts_at");

-- ─── Offers ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "offers" (
  "id"                 TEXT NOT NULL,
  "demand_id"          TEXT NOT NULL,
  "seller_id"          TEXT NOT NULL,
  "location_id"        TEXT NOT NULL,
  "window_id"          TEXT,
  "sku_template_id"    TEXT NOT NULL,
  "starts_at"          TIMESTAMP(3) NOT NULL,
  "duration_mins"      INTEGER NOT NULL,
  "price_cents"        INTEGER NOT NULL,
  "capacity"           INTEGER NOT NULL,
  "terms"              TEXT,
  "state"              TEXT NOT NULL DEFAULT 'OFFERED',
  "hold_expires_at"    TIMESTAMP(3) NOT NULL,
  "created_by_seat_id" TEXT NOT NULL,
  "bookable_id"        TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_state_known"
    CHECK ("state" IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A hold is a promise with a deadline or it is not a hold.
DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_hold_after_creation"
    CHECK ("hold_expires_at" > "created_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_shape_sane"
    CHECK ("duration_mins" > 0 AND "price_cents" >= 0 AND "capacity" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Only an accepted offer may carry a Bookable, and an accepted offer must.
DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_bookable_follows_acceptance"
    CHECK (("state" = 'ACCEPTED' AND "bookable_id" IS NOT NULL)
        OR ("state" <> 'ACCEPTED' AND "bookable_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_demand_id_fkey"
    FOREIGN KEY ("demand_id") REFERENCES "demands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_seller_id_fkey"
    FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "vendor_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_window_id_fkey"
    FOREIGN KEY ("window_id") REFERENCES "vendor_availability_windows"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_bookable_id_fkey"
    FOREIGN KEY ("bookable_id") REFERENCES "bookables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "offers_bookable_id_key" ON "offers" ("bookable_id");
CREATE INDEX IF NOT EXISTS "offers_demand_id_state_idx" ON "offers" ("demand_id", "state");
CREATE INDEX IF NOT EXISTS "offers_seller_id_state_created_at_idx" ON "offers" ("seller_id", "state", "created_at");
CREATE INDEX IF NOT EXISTS "offers_state_hold_expires_at_idx" ON "offers" ("state", "hold_expires_at");

-- ─── Demand events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "demand_events" (
  "id"          TEXT NOT NULL,
  "demand_id"   TEXT NOT NULL,
  "offer_id"    TEXT,
  "seller_id"   TEXT,
  "kind"        TEXT NOT NULL,
  "detail"      JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "demand_events_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "demand_events" ADD CONSTRAINT "demand_events_kind_known"
    CHECK ("kind" IN ('PUBLISHED', 'BROADCAST', 'VIEWED', 'OFFERED', 'DECLINED',
                      'ACCEPTED', 'WITHDRAWN', 'EXPIRED', 'NO_SHOW', 'SETTLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "demand_events_demand_id_occurred_at_idx"
  ON "demand_events" ("demand_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "demand_events_seller_id_kind_occurred_at_idx"
  ON "demand_events" ("seller_id", "kind", "occurred_at");

-- Append-only is enforced, not requested. A log that can be rewritten after the
-- fact is not evidence, and every later optimisation reads this table as though
-- it were. No foreign key to demands: evidence must outlive the thing it
-- describes, so a deleted demand cannot erase the record of what was offered.
CREATE OR REPLACE FUNCTION "demand_events_append_only"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'demand_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "demand_events_no_update" ON "demand_events";
CREATE TRIGGER "demand_events_no_update"
  BEFORE UPDATE ON "demand_events"
  FOR EACH ROW EXECUTE FUNCTION "demand_events_append_only"();

DROP TRIGGER IF EXISTS "demand_events_no_delete" ON "demand_events";
CREATE TRIGGER "demand_events_no_delete"
  BEFORE DELETE ON "demand_events"
  FOR EACH ROW EXECUTE FUNCTION "demand_events_append_only"();
