-- REA review 2026-11-10 (X2): dispute, refund and early-fraud-warning
-- handling, and automatic refunds when a party is cancelled or removed.
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "refund_id" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMP(3);
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "refund_reason" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "disputed_at" TIMESTAMP(3);
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "dispute_status" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "fraud_warning_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "party_checkouts_payment_intent_id_idx" ON "party_checkouts"("payment_intent_id");

ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "vendor_ticket_orders_payment_intent_id_idx" ON "vendor_ticket_orders"("payment_intent_id");
