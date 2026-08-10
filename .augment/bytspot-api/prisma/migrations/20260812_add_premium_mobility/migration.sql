-- Make the premium entitlement explicit. Existing Premium subscribers retain
-- their access as Platinum; new and non-premium users are Green.
ALTER TABLE "users"
  ADD COLUMN "membership_tier" TEXT NOT NULL DEFAULT 'green';

UPDATE "users"
  SET "membership_tier" = 'platinum'
  WHERE "is_premium" = true;

ALTER TABLE "users"
  ADD CONSTRAINT "users_membership_tier_check"
  CHECK ("membership_tier" IN ('green', 'platinum', 'black'));

CREATE TABLE "mobility_quotes" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_quote_id" TEXT,
  "service_class" TEXT NOT NULL,
  "service_title" TEXT NOT NULL,
  "price_label" TEXT,
  "eta_label" TEXT,
  "pickup_lat" DOUBLE PRECISION NOT NULL,
  "pickup_lng" DOUBLE PRECISION NOT NULL,
  "pickup_label" TEXT NOT NULL,
  "dropoff_label" TEXT NOT NULL,
  "booking_mode" TEXT NOT NULL DEFAULT 'handoff',
  "status" TEXT NOT NULL DEFAULT 'ready',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "provider_payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mobility_quotes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mobility_quotes_provider_check" CHECK ("provider" IN ('handoff', 'aggregator')),
  CONSTRAINT "mobility_quotes_booking_mode_check" CHECK ("booking_mode" IN ('handoff', 'provider-booking')),
  CONSTRAINT "mobility_quotes_status_check" CHECK ("status" IN ('ready', 'expired', 'consumed', 'cancelled'))
);

CREATE TABLE "mobility_trips" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "quote_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_reservation_id" TEXT,
  "handoff_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'handoff_pending',
  "cancellation_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mobility_trips_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mobility_trips_provider_check" CHECK ("provider" IN ('uber', 'lyft', 'aggregator')),
  CONSTRAINT "mobility_trips_status_check" CHECK ("status" IN ('handoff_pending', 'cancelled', 'provider_pending', 'confirmed', 'failed'))
);

CREATE UNIQUE INDEX "mobility_trips_quote_id_key" ON "mobility_trips"("quote_id");
CREATE UNIQUE INDEX "mobility_trips_user_id_idempotency_key_key" ON "mobility_trips"("user_id", "idempotency_key");
CREATE INDEX "mobility_quotes_user_id_expires_at_idx" ON "mobility_quotes"("user_id", "expires_at");
CREATE INDEX "mobility_quotes_venue_id_created_at_idx" ON "mobility_quotes"("venue_id", "created_at" DESC);
CREATE INDEX "mobility_trips_user_id_updated_at_idx" ON "mobility_trips"("user_id", "updated_at" DESC);

ALTER TABLE "mobility_quotes"
  ADD CONSTRAINT "mobility_quotes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mobility_quotes"
  ADD CONSTRAINT "mobility_quotes_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mobility_trips"
  ADD CONSTRAINT "mobility_trips_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mobility_trips"
  ADD CONSTRAINT "mobility_trips_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "mobility_quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;