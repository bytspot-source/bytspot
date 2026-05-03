-- Add Stripe refund/dispute identifiers for point restoration audit rows.
ALTER TABLE "point_transactions"
  ADD COLUMN "stripe_refund_id" TEXT,
  ADD COLUMN "stripe_dispute_id" TEXT;

CREATE UNIQUE INDEX "point_transactions_stripe_refund_id_key"
  ON "point_transactions"("stripe_refund_id");

CREATE UNIQUE INDEX "point_transactions_stripe_dispute_id_key"
  ON "point_transactions"("stripe_dispute_id");