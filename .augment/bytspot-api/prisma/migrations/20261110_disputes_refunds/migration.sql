-- REA review 2026-11-10 (X2): dispute, refund and early-fraud-warning
-- handling, and automatic refunds when a party is cancelled or removed.
ALTER TABLE "party_checkouts" ADD COLUMN "refund_id" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN "refunded_at" TIMESTAMP(3);
ALTER TABLE "party_checkouts" ADD COLUMN "refund_reason" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN "disputed_at" TIMESTAMP(3);
ALTER TABLE "party_checkouts" ADD COLUMN "dispute_status" TEXT;
ALTER TABLE "party_checkouts" ADD COLUMN "fraud_warning_at" TIMESTAMP(3);
CREATE INDEX "party_checkouts_payment_intent_id_idx" ON "party_checkouts"("payment_intent_id");

ALTER TABLE "parties" ADD COLUMN "cancelled_at" TIMESTAMP(3);

CREATE TABLE "stripe_webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vendor_ticket_orders_payment_intent_id_idx" ON "vendor_ticket_orders"("payment_intent_id");
