ALTER TABLE "point_transactions" ADD COLUMN "stripe_session_id" TEXT;
ALTER TABLE "point_transactions" ADD COLUMN "stripe_payment_intent_id" TEXT;

CREATE UNIQUE INDEX "point_transactions_stripe_session_id_key" ON "point_transactions"("stripe_session_id");
CREATE UNIQUE INDEX "point_transactions_stripe_payment_intent_id_key" ON "point_transactions"("stripe_payment_intent_id");
CREATE INDEX "point_transactions_category_created_at_idx" ON "point_transactions"("category", "created_at" DESC);