-- AlterTable: add isPremium + stripeCustomerId to users
ALTER TABLE "users" ADD COLUMN "is_premium" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" TEXT;

-- CreateIndex: unique constraint on stripe_customer_id
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

-- CreateTable: tips
CREATE TABLE "tips" (
    "id" TEXT NOT NULL,
    "from_user_id" TEXT NOT NULL,
    "to_valet_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "stripe_payment_intent_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tips_stripe_payment_intent_id_key" ON "tips"("stripe_payment_intent_id");
CREATE INDEX "tips_from_user_id_idx" ON "tips"("from_user_id");
CREATE INDEX "tips_to_valet_id_idx" ON "tips"("to_valet_id");

-- AddForeignKey
ALTER TABLE "tips" ADD CONSTRAINT "tips_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

