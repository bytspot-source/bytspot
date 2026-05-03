-- CreateTable: access_passes
CREATE TABLE "access_passes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "location" TEXT NOT NULL,
    "price_label" TEXT NOT NULL,
    "access_label" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "ticket_url" TEXT,
    "source" TEXT NOT NULL DEFAULT 'app',
    "stripe_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_passes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_passes_stripe_session_id_key" ON "access_passes"("stripe_session_id");

-- CreateIndex
CREATE INDEX "access_passes_user_id_created_at_idx" ON "access_passes"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "access_passes_user_id_product_type_product_id_idx" ON "access_passes"("user_id", "product_type", "product_id");

-- AddForeignKey
ALTER TABLE "access_passes"
ADD CONSTRAINT "access_passes_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;