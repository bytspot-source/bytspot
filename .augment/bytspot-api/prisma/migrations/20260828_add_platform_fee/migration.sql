-- Adjustable platform fee, appended rather than overwritten so the rate on any
-- past date stays provable.
CREATE TABLE "platform_fee_settings" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'party-ticket',
    "fee_bps" INTEGER NOT NULL,
    "note" TEXT,
    "set_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_fee_settings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_fee_settings_scope_created_at_idx"
    ON "platform_fee_settings"("scope", "created_at" DESC);

-- Frozen at publish. NULL on drafts and on parties published before the fee
-- existed; those are never charged a rate retroactively.
ALTER TABLE "parties" ADD COLUMN "platform_fee_bps" INTEGER;

-- The split as it stood for each individual sale.
ALTER TABLE "party_checkouts" ADD COLUMN "platform_fee_bps" INTEGER;
ALTER TABLE "party_checkouts" ADD COLUMN "platform_fee_cents" INTEGER;
ALTER TABLE "party_checkouts" ADD COLUMN "host_net_cents" INTEGER;
