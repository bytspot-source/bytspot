-- CreateTable: wallet ledger entries for native Profile/My Access/Arrivals
CREATE TABLE "wallet_ledger_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "venue_name" TEXT,
    "provider_name" TEXT,
    "window_label" TEXT,
    "payment_state" TEXT NOT NULL DEFAULT 'unknown',
    "provider_state" TEXT NOT NULL DEFAULT 'pending',
    "reservation_reference" TEXT,
    "amount_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "source" TEXT NOT NULL DEFAULT 'server',
    "receipt_url" TEXT,
    "actions" JSONB,
    "metadata" JSONB,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_ledger_entries_user_id_created_at_idx" ON "wallet_ledger_entries"("user_id", "created_at" DESC);
CREATE INDEX "wallet_ledger_entries_user_id_product_type_idx" ON "wallet_ledger_entries"("user_id", "product_type");
CREATE INDEX "wallet_ledger_entries_provider_state_idx" ON "wallet_ledger_entries"("provider_state");

-- AddForeignKey
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
