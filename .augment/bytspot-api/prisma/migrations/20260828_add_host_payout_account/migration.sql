-- Host payout rail: the connected account a paid party's ticket revenue is
-- sent to, plus Stripe's own verdict on whether it may take charges and
-- receive payouts. The flags are a mirror for cheap reads; Stripe remains the
-- source of truth and is re-read before a paid party publishes.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_account_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_account_refreshed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "users_stripe_account_id_key" ON "users"("stripe_account_id");

-- Null on an existing row is the honest record: those sales were made before
-- the rail existed and were never transferred anywhere.
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "destination_account_id" TEXT;

-- Refund support: the PaymentIntent is what a reversal is issued against, and
-- refundedAt records that the reversal actually happened rather than leaving
-- "refund-required" as the only trace.
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMP(3);
