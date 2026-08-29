-- A party checkout is a financial ledger, not a profile record. Deleting a
-- host, a guest row or a party used to cascade the charge away, destroying the
-- only local pointer to the Stripe payment while a refund could still be owed.
-- The identity links now detach instead: erasure clears who, never what.
ALTER TABLE "party_checkouts" ALTER COLUMN "party_id" DROP NOT NULL;
ALTER TABLE "party_checkouts" ALTER COLUMN "party_guest_id" DROP NOT NULL;
ALTER TABLE "party_checkouts" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "party_checkouts" DROP CONSTRAINT IF EXISTS "party_checkouts_party_id_fkey";
ALTER TABLE "party_checkouts" DROP CONSTRAINT IF EXISTS "party_checkouts_party_guest_id_fkey";
ALTER TABLE "party_checkouts" DROP CONSTRAINT IF EXISTS "party_checkouts_user_id_fkey";

ALTER TABLE "party_checkouts"
  ADD CONSTRAINT "party_checkouts_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "party_checkouts"
  ADD CONSTRAINT "party_checkouts_party_guest_id_fkey"
  FOREIGN KEY ("party_guest_id") REFERENCES "party_guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "party_checkouts"
  ADD CONSTRAINT "party_checkouts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
