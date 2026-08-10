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
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "party_guests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_guests_party_id_user_id_key" ON "party_guests"("party_id", "user_id");
CREATE INDEX "party_guests_party_id_status_idx" ON "party_guests"("party_id", "status");
CREATE INDEX "party_guests_user_id_updated_at_idx" ON "party_guests"("user_id", "updated_at" DESC);

ALTER TABLE "party_guests"
  ADD CONSTRAINT "party_guests_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "party_guests"
  ADD CONSTRAINT "party_guests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "party_checkouts" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "party_guest_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "stripe_session_id" TEXT,
  "checkout_url" TEXT,
  "ticket_tier_name" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "status" TEXT NOT NULL DEFAULT 'creating',
  "reservation_expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "party_checkouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_checkouts_stripe_session_id_key" ON "party_checkouts"("stripe_session_id");
CREATE UNIQUE INDEX "party_checkouts_party_id_user_id_idempotency_key_key" ON "party_checkouts"("party_id", "user_id", "idempotency_key");
CREATE INDEX "party_checkouts_party_id_ticket_tier_name_status_reservation_expires_at_idx" ON "party_checkouts"("party_id", "ticket_tier_name", "status", "reservation_expires_at");
CREATE INDEX "party_checkouts_party_guest_id_updated_at_idx" ON "party_checkouts"("party_guest_id", "updated_at" DESC);

ALTER TABLE "party_checkouts"
  ADD CONSTRAINT "party_checkouts_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "party_checkouts"
  ADD CONSTRAINT "party_checkouts_party_guest_id_fkey"
  FOREIGN KEY ("party_guest_id") REFERENCES "party_guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "party_checkouts"
  ADD CONSTRAINT "party_checkouts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;