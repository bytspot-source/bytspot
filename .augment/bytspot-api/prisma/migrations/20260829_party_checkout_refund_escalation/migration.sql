-- A refund that keeps failing must be a standing, queryable obligation rather
-- than a line in a log an operator has to notice.
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "refund_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "last_refund_failure_at" TIMESTAMP(3);
