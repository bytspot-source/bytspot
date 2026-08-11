-- A host may bind a published Party to one registered Bytspot Venue. The
-- destination remains private until a guest has Party access.
ALTER TABLE "parties"
  ADD COLUMN "arrival_venue_id" TEXT;

CREATE INDEX "parties_arrival_venue_id_idx" ON "parties"("arrival_venue_id");

ALTER TABLE "parties"
  ADD CONSTRAINT "parties_arrival_venue_id_fkey"
  FOREIGN KEY ("arrival_venue_id") REFERENCES "venues"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;