-- 20261028_host_payouts was edited after production applied it, so production
-- has party_payout_transfers without the reversal columns, index and checks.
-- Each statement is a no-op where the edited migration already ran.
ALTER TABLE "party_payout_transfers" ADD COLUMN IF NOT EXISTS "reversed_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "party_payout_transfers" ADD COLUMN IF NOT EXISTS "checked_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "party_payout_transfers_status_paid_at_idx" ON "party_payout_transfers"("status", "paid_at");

ALTER TABLE "party_payout_transfers" DROP CONSTRAINT IF EXISTS "party_payout_transfers_status_check";
ALTER TABLE "party_payout_transfers" ADD CONSTRAINT "party_payout_transfers_status_check" CHECK ("status" IN ('pending', 'paid', 'held', 'failed', 'reversed'));
ALTER TABLE "party_payout_transfers" DROP CONSTRAINT IF EXISTS "party_payout_transfers_reversed_check";
ALTER TABLE "party_payout_transfers" ADD CONSTRAINT "party_payout_transfers_reversed_check" CHECK ("reversed_cents" >= 0 AND "reversed_cents" <= "amount_cents");
