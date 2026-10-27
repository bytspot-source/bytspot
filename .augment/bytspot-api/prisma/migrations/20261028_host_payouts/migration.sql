-- Host payouts: a Stripe Express account per host, the charge each party sale
-- was paid by, and one transfer row per recipient of a sale.
-- AlterTable
ALTER TABLE "party_checkouts" ADD COLUMN "payment_intent_id" TEXT;

-- CreateTable
CREATE TABLE "host_payout_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stripe_account_id" TEXT NOT NULL,
    "status" "VendorPayoutStatus" NOT NULL DEFAULT 'pending',
    "last4" TEXT,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "host_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_payout_transfers" (
    "id" TEXT NOT NULL,
    "checkout_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipient_user_id" TEXT,
    "seller_id" TEXT,
    "destination" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripe_transfer_id" TEXT,
    "detail" TEXT,
    "paid_at" TIMESTAMP(3),
    "reversed_cents" INTEGER NOT NULL DEFAULT 0,
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_payout_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "host_payout_accounts_user_id_key" ON "host_payout_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "host_payout_accounts_stripe_account_id_key" ON "host_payout_accounts"("stripe_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "party_payout_transfers_stripe_transfer_id_key" ON "party_payout_transfers"("stripe_transfer_id");

-- CreateIndex
CREATE INDEX "party_payout_transfers_status_updated_at_idx" ON "party_payout_transfers"("status", "updated_at");

-- CreateIndex
CREATE INDEX "party_payout_transfers_status_paid_at_idx" ON "party_payout_transfers"("status", "paid_at");

-- CreateIndex
CREATE INDEX "party_payout_transfers_recipient_user_id_idx" ON "party_payout_transfers"("recipient_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "party_payout_transfers_checkout_id_recipient_key" ON "party_payout_transfers"("checkout_id", "recipient");

-- AddForeignKey
ALTER TABLE "host_payout_accounts" ADD CONSTRAINT "host_payout_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_payout_transfers" ADD CONSTRAINT "party_payout_transfers_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "party_checkouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same bounds the API holds, enforced by the database too.
ALTER TABLE "party_payout_transfers" ADD CONSTRAINT "party_payout_transfers_recipient_check" CHECK ("recipient" IN ('host', 'seller'));
ALTER TABLE "party_payout_transfers" ADD CONSTRAINT "party_payout_transfers_status_check" CHECK ("status" IN ('pending', 'paid', 'held', 'failed', 'reversed'));
ALTER TABLE "party_payout_transfers" ADD CONSTRAINT "party_payout_transfers_reversed_check" CHECK ("reversed_cents" >= 0 AND "reversed_cents" <= "amount_cents");
ALTER TABLE "party_payout_transfers" ADD CONSTRAINT "party_payout_transfers_amount_check" CHECK ("amount_cents" > 0);
