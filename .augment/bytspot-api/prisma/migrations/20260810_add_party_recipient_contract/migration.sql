ALTER TABLE "parties"
  ADD COLUMN "location_disclosure" TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN "host_destinations" JSONB;

CREATE TABLE "party_guests" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "access_granted" BOOLEAN NOT NULL DEFAULT false,
  "ticket_tier_name" TEXT,
  "stripe_session_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "party_guests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_guests_party_id_user_id_key" ON "party_guests"("party_id", "user_id");
CREATE UNIQUE INDEX "party_guests_stripe_session_id_key" ON "party_guests"("stripe_session_id");
CREATE INDEX "party_guests_party_id_status_idx" ON "party_guests"("party_id", "status");
CREATE INDEX "party_guests_user_id_updated_at_idx" ON "party_guests"("user_id", "updated_at" DESC);

ALTER TABLE "party_guests"
  ADD CONSTRAINT "party_guests_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "party_guests"
  ADD CONSTRAINT "party_guests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;