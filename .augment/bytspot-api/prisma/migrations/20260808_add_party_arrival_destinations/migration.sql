CREATE TABLE "party_arrival_destinations" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "bound_by_user_id" TEXT NOT NULL,
    "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_arrival_destinations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_arrival_destinations_party_id_key" ON "party_arrival_destinations"("party_id");
CREATE INDEX "party_arrival_destinations_venue_id_idx" ON "party_arrival_destinations"("venue_id");
CREATE INDEX "party_arrival_destinations_bound_by_user_id_bound_at_idx" ON "party_arrival_destinations"("bound_by_user_id", "bound_at" DESC);

ALTER TABLE "party_arrival_destinations" ADD CONSTRAINT "party_arrival_destinations_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_arrival_destinations" ADD CONSTRAINT "party_arrival_destinations_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "party_arrival_destinations" ADD CONSTRAINT "party_arrival_destinations_bound_by_user_id_fkey"
  FOREIGN KEY ("bound_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;