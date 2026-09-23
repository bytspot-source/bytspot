-- Paying for a table, with or without a gate fee.
--
-- A checkout used to be one thing: a ticket. Now a guest may be buying a gate
-- ticket, a table, or both at once, and free at the door with paid tables is
-- an ordinary arrangement — so a checkout can no longer assume a ticket tier
-- exists.

ALTER TABLE "party_checkouts" ALTER COLUMN "ticket_tier_name" DROP NOT NULL;

ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "table_id" TEXT;

-- What of the charge is the table's, recorded rather than derived from today's
-- prices: a host editing a table later must not be able to restate what a
-- guest already paid. The gate's share is the remainder, so the two can never
-- drift apart the way a third column would allow.
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "table_amount_cents" INTEGER NOT NULL DEFAULT 0;

-- A checkout that is neither a gate ticket nor a table is a charge for
-- nothing, and must not be representable.
ALTER TABLE "party_checkouts" DROP CONSTRAINT IF EXISTS "party_checkouts_buy_something";
ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_buy_something"
  CHECK ("ticket_tier_name" IS NOT NULL OR "table_id" IS NOT NULL);

ALTER TABLE "party_checkouts" DROP CONSTRAINT IF EXISTS "party_checkouts_table_amount_sane";
ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_table_amount_sane"
  CHECK ("table_amount_cents" >= 0 AND "table_amount_cents" <= "amount_cents");

-- RESTRICT, not CASCADE or SET NULL. A table somebody is mid-checkout on is
-- not the host's to delete: SET NULL would quietly turn a paid table into a
-- bare gate ticket, and CASCADE would erase the record of a charge. The API
-- refuses the removal first; this is the half that cannot be forgotten.
ALTER TABLE "party_checkouts" DROP CONSTRAINT IF EXISTS "party_checkouts_table_id_fkey";
ALTER TABLE "party_checkouts" ADD CONSTRAINT "party_checkouts_table_id_fkey"
  FOREIGN KEY ("table_id") REFERENCES "party_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Counting the live claims on one table, which is how a table is judged sold
-- out while payments are still in flight.
CREATE INDEX IF NOT EXISTS "party_checkouts_table_id_status_reservation_expires_at_idx"
  ON "party_checkouts" ("table_id", "status", "reservation_expires_at");
