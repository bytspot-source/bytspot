-- A table won from the demand rail becomes part of the Plan.
--
-- Until now an accepted offer produced a Bookable and stopped there, so the
-- only place a confirmed booking appeared was the demand inbox. The Plan the
-- guest built — the thing they actually open — never learned about it.
--
-- This is the third supply a PlanItem may carry, alongside a party and a
-- coffee reservation, and it obeys the same rule as the other two: a single
-- supply per item, enforced by the database rather than by the writer.
ALTER TABLE "plan_items" ADD COLUMN IF NOT EXISTS "offer_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "plan_items_offer_id_key" ON "plan_items"("offer_id");

-- Restrict, not set-null. Set-null would leave an item claiming a booked table
-- with no supply behind it, which the promise guard below would then have to
-- allow. An accepted offer is not deleted in the ordinary course; if something
-- tries, it should fail loudly rather than quietly hollow out a booking.
DO $$ BEGIN
  ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Replace-in-place: drop-if-exists before add lets a retry through without
-- depending on state left by a failed apply.

-- An offer is real supply, so an item backed by one may carry a promise.
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_no_supply_no_promise_check";
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_no_supply_no_promise_check"
    CHECK ("party_id" IS NOT NULL OR "coffee_reservation_id" IS NOT NULL
           OR "coffee_spot_id" IS NOT NULL OR "offer_id" IS NOT NULL
           OR "capability" = 'details');

-- Still at most one supply per item.
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_selection_supply_check";
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_selection_supply_check"
    CHECK (num_nonnulls("party_id", "coffee_reservation_id", "coffee_spot_id", "offer_id") <= 1);

-- What an offer-backed item is allowed to say about itself.
--
-- The offer was accepted and capacity was committed, so this is a booking and
-- nothing weaker: `book`, and never 'available' or 'held', which would invite
-- a second attempt to reserve a table the guest already holds. It must carry
-- the frozen snapshot of what was agreed, and its selection key is derived
-- from the offer so the same accept cannot attach twice under two names.
ALTER TABLE "plan_items" DROP CONSTRAINT IF EXISTS "plan_items_vendor_offer_booked_check";
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_vendor_offer_booked_check"
    CHECK ("offer_id" IS NULL OR (
      "capability" = 'book' AND "status" IN ('booked', 'cancelled')
      AND "bookable_id" IS NOT NULL
      AND "selection_key" IS NOT NULL
      AND "selection_key" = ('vendorOffer:' || "offer_id")
    ));

-- The item is no longer the only owner of its snapshot.
--
-- `delete_orphaned_bookable` was written when a Bookable belonged to exactly
-- one plan_item, so removing the item could take the snapshot with it. An
-- offer-backed item shares its snapshot with the accepted offer that produced
-- it, and that offer is required by `offers_bookable_follows_acceptance` to
-- keep pointing at one. Deleting the row out from under it nulls the offer's
-- pointer and the accepted offer immediately violates its own contract.
--
-- Orphaned now means orphaned: still delete the snapshot when nothing else
-- holds it, and leave it alone when something does.
-- Either owner may go first, so both ask the same question: is anyone else
-- still holding this snapshot? Whoever leaves last turns the light off.
CREATE OR REPLACE FUNCTION delete_orphaned_bookable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.bookable_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "offers" WHERE "bookable_id" = OLD.bookable_id)
     AND NOT EXISTS (SELECT 1 FROM "plan_items" WHERE "bookable_id" = OLD.bookable_id) THEN
    DELETE FROM "bookables" WHERE "id" = OLD.bookable_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS offers_delete_bookable ON offers;
CREATE TRIGGER offers_delete_bookable
AFTER DELETE ON offers
FOR EACH ROW EXECUTE FUNCTION delete_orphaned_bookable();

-- An offer-backed item must carry the snapshot of the offer it names, not
-- merely some snapshot. A CHECK cannot see another table and a composite
-- foreign key cannot be expressed here (bookable_id already backs its own
-- reference), so this is a trigger, matching how the rest of this schema
-- states cross-table invariants.
CREATE OR REPLACE FUNCTION plan_item_offer_snapshot_matches() RETURNS TRIGGER AS $$
DECLARE
  offer_bookable TEXT;
BEGIN
  IF NEW.offer_id IS NULL THEN RETURN NEW; END IF;
  SELECT "bookable_id" INTO offer_bookable FROM "offers" WHERE "id" = NEW.offer_id;
  IF offer_bookable IS DISTINCT FROM NEW.bookable_id THEN
    RAISE EXCEPTION 'plan_items.bookable_id must be the snapshot of offer_id %', NEW.offer_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plan_items_offer_snapshot ON plan_items;
CREATE TRIGGER plan_items_offer_snapshot
BEFORE INSERT OR UPDATE OF offer_id, bookable_id ON plan_items
FOR EACH ROW EXECUTE FUNCTION plan_item_offer_snapshot_matches();
