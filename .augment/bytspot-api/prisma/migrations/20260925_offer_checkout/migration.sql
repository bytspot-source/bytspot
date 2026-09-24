-- Pay for an offer in the app before the table is committed.
--
-- Every existing offer settles at the venue, which is what the default keeps.

ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "pay_at" TEXT NOT NULL DEFAULT 'venue';

DO $$ BEGIN
  ALTER TABLE "offers" ADD CONSTRAINT "offers_pay_at_check" CHECK ("pay_at" IN ('venue', 'bytspot'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "offer_checkouts" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_checkouts_pkey" PRIMARY KEY ("id")
);

-- The split must add up to what the guest paid, and nothing is free by accident.
DO $$ BEGIN
  ALTER TABLE "offer_checkouts" ADD CONSTRAINT "offer_checkouts_amounts_check" CHECK (
    "amount_cents" > 0 AND "platform_fee_cents" >= 0 AND "seller_net_cents" >= 0
    AND "platform_fee_cents" + "seller_net_cents" = "amount_cents"
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offer_checkouts" ADD CONSTRAINT "offer_checkouts_status_check"
    CHECK ("status" IN ('creating', 'pending', 'completed', 'refunded', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "offer_checkouts_stripe_session_id_key" ON "offer_checkouts"("stripe_session_id");
CREATE INDEX IF NOT EXISTS "offer_checkouts_offer_id_status_idx" ON "offer_checkouts"("offer_id", "status");
CREATE INDEX IF NOT EXISTS "offer_checkouts_user_id_created_at_idx" ON "offer_checkouts"("user_id", "created_at" DESC);

DO $$ BEGIN
  ALTER TABLE "offer_checkouts" ADD CONSTRAINT "offer_checkouts_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "offer_checkouts" ADD CONSTRAINT "offer_checkouts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
