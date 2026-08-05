CREATE TABLE "checkout_attempts" (
  "id" TEXT NOT NULL,
  "party_ticket_order_id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "ticket_tier_name" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "stripe_session_id" TEXT,
  "stripe_payment_intent_id" TEXT,
  "reconciliation_state" TEXT NOT NULL DEFAULT 'pending',
  "checkout_expires_at" TIMESTAMP(3) NOT NULL,
  "reconciled_at" TIMESTAMP(3),
  "failure_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "checkout_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkout_attempts_stripe_session_id_key" ON "checkout_attempts"("stripe_session_id");
CREATE UNIQUE INDEX "checkout_attempts_stripe_payment_intent_id_key" ON "checkout_attempts"("stripe_payment_intent_id");
CREATE INDEX "checkout_attempts_party_ticket_order_id_reconciliation_state_created_at_idx" ON "checkout_attempts"("party_ticket_order_id", "reconciliation_state", "created_at" DESC);
CREATE INDEX "checkout_attempts_party_id_ticket_tier_name_reconciliation_state_idx" ON "checkout_attempts"("party_id", "ticket_tier_name", "reconciliation_state");
CREATE INDEX "checkout_attempts_user_id_reconciliation_state_created_at_idx" ON "checkout_attempts"("user_id", "reconciliation_state", "created_at" DESC);

ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_party_ticket_order_id_fkey" FOREIGN KEY ("party_ticket_order_id") REFERENCES "party_ticket_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;