-- CreateEnum
CREATE TYPE "PartySellerInviteState" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'REMOVED');

-- AlterTable
ALTER TABLE "party_checkouts" ADD COLUMN     "seller_id" TEXT,
ADD COLUMN     "seller_net_cents" INTEGER;

-- CreateTable
CREATE TABLE "party_seller_invites" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "state" "PartySellerInviteState" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "responded_by_user_id" TEXT,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_seller_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "party_seller_invites_seller_id_state_idx" ON "party_seller_invites"("seller_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "party_seller_invites_party_id_seller_id_key" ON "party_seller_invites"("party_id", "seller_id");

-- AddForeignKey
ALTER TABLE "party_seller_invites" ADD CONSTRAINT "party_seller_invites_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_seller_invites" ADD CONSTRAINT "party_seller_invites_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "vendor_sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

