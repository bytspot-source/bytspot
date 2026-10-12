-- Dated tickets a business sells itself, and the guests' paid orders for them.
CREATE TABLE IF NOT EXISTS "vendor_tickets" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "created_by_seat_id" TEXT,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "vendor_ticket_orders" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "platform_fee_bps" INTEGER NOT NULL,
    "platform_fee_cents" INTEGER NOT NULL,
    "seller_net_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "stripe_session_id" TEXT,
    "checkout_url" TEXT,
    "payment_intent_id" TEXT,
    "refund_id" TEXT,
    "refund_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "pass_code" TEXT,
    "checked_in_at" TIMESTAMP(3),
    "checked_in_by_seat_id" TEXT,
    "no_show_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_ticket_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "vendor_tickets_seller_id_starts_at_idx" ON "vendor_tickets"("seller_id", "starts_at");
CREATE INDEX IF NOT EXISTS "vendor_tickets_location_id_starts_at_idx" ON "vendor_tickets"("location_id", "starts_at");
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_ticket_orders_stripe_session_id_key" ON "vendor_ticket_orders"("stripe_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_ticket_orders_pass_code_key" ON "vendor_ticket_orders"("pass_code");
CREATE INDEX IF NOT EXISTS "vendor_ticket_orders_ticket_id_status_idx" ON "vendor_ticket_orders"("ticket_id", "status");
CREATE INDEX IF NOT EXISTS "vendor_ticket_orders_seller_id_status_idx" ON "vendor_ticket_orders"("seller_id", "status");
CREATE INDEX IF NOT EXISTS "vendor_ticket_orders_user_id_created_at_idx" ON "vendor_ticket_orders"("user_id", "created_at" DESC);

-- One paid ticket per guest per date.
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_ticket_orders_one_per_guest_key" ON "vendor_ticket_orders"("ticket_id", "user_id") WHERE "status" IN ('settling', 'completed');

DO $$ BEGIN
  ALTER TABLE "vendor_tickets" ADD CONSTRAINT "vendor_tickets_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_tickets" ADD CONSTRAINT "vendor_tickets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "vendor_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_ticket_orders" ADD CONSTRAINT "vendor_ticket_orders_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "vendor_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_ticket_orders" ADD CONSTRAINT "vendor_ticket_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A sold-out date cannot be oversold, and nothing is free by accident.
DO $$ BEGIN
  ALTER TABLE "vendor_tickets" ADD CONSTRAINT "vendor_tickets_shape_check" CHECK (
    "price_cents" > 0 AND "quantity" > 0 AND "sold" >= 0 AND "sold" <= "quantity" AND "ends_at" > "starts_at"
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_ticket_orders" ADD CONSTRAINT "vendor_ticket_orders_amounts_check" CHECK (
    "amount_cents" > 0 AND "platform_fee_cents" >= 0 AND "seller_net_cents" >= 0
    AND "platform_fee_cents" + "seller_net_cents" = "amount_cents"
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_ticket_orders" ADD CONSTRAINT "vendor_ticket_orders_status_check"
    CHECK ("status" IN ('creating', 'pending', 'settling', 'completed', 'refunded', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
