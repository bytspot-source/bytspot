-- Party-native participation, explicit entitlement authority, and verified
-- post-Party relationship evidence. These tables never project into legacy
-- group_events or group_event_guests.
CREATE TABLE "party_participations" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'rsvp',
  "checked_in_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_participations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "party_participations_party_id_user_id_key" ON "party_participations"("party_id", "user_id");
CREATE INDEX "party_participations_party_id_status_idx" ON "party_participations"("party_id", "status");
CREATE INDEX "party_participations_user_id_updated_at_idx" ON "party_participations"("user_id", "updated_at" DESC);
ALTER TABLE "party_participations" ADD CONSTRAINT "party_participations_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_participations" ADD CONSTRAINT "party_participations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "membership_entitlements" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "membership_entitlements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "membership_entitlements_user_id_tier_status_idx" ON "membership_entitlements"("user_id", "tier", "status");
ALTER TABLE "membership_entitlements" ADD CONSTRAINT "membership_entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "party_connections" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "from_user_id" TEXT NOT NULL,
  "to_user_id" TEXT NOT NULL,
  "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "party_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "party_connections_party_id_from_user_id_to_user_id_key" ON "party_connections"("party_id", "from_user_id", "to_user_id");
CREATE INDEX "party_connections_from_user_id_verified_at_idx" ON "party_connections"("from_user_id", "verified_at" DESC);
CREATE INDEX "party_connections_to_user_id_verified_at_idx" ON "party_connections"("to_user_id", "verified_at" DESC);
ALTER TABLE "party_connections" ADD CONSTRAINT "party_connections_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_connections" ADD CONSTRAINT "party_connections_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_connections" ADD CONSTRAINT "party_connections_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "party_ticket_orders" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "ticket_tier_name" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "status" TEXT NOT NULL DEFAULT 'pending_checkout',
  "idempotency_key" TEXT NOT NULL,
  "stripe_session_id" TEXT,
  "stripe_payment_intent_id" TEXT,
  "checkout_expires_at" TIMESTAMP(3),
  "paid_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_ticket_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "party_ticket_orders_stripe_session_id_key" ON "party_ticket_orders"("stripe_session_id");
CREATE UNIQUE INDEX "party_ticket_orders_stripe_payment_intent_id_key" ON "party_ticket_orders"("stripe_payment_intent_id");
CREATE UNIQUE INDEX "party_ticket_orders_party_id_user_id_key" ON "party_ticket_orders"("party_id", "user_id");
CREATE INDEX "party_ticket_orders_party_id_status_idx" ON "party_ticket_orders"("party_id", "status");
CREATE INDEX "party_ticket_orders_user_id_updated_at_idx" ON "party_ticket_orders"("user_id", "updated_at" DESC);
ALTER TABLE "party_ticket_orders" ADD CONSTRAINT "party_ticket_orders_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_ticket_orders" ADD CONSTRAINT "party_ticket_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;