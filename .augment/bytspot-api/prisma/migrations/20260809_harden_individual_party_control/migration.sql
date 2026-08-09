-- Persist the client request identity before Stripe session creation so a retry
-- can use Stripe idempotency safely after a process interruption.
ALTER TABLE "party_guests" ADD COLUMN IF NOT EXISTS "checkout_idempotency_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "party_guests_checkout_idempotency_key_key"
  ON "party_guests"("checkout_idempotency_key");