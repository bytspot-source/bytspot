-- CreateTable
CREATE TABLE "map_report_relay_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_report_relay_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "map_report_relay_keys_public_key_key" ON "map_report_relay_keys"("public_key");

-- CreateIndex
CREATE INDEX "map_report_relay_keys_user_id_created_at_idx" ON "map_report_relay_keys"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "map_report_relay_keys" ADD CONSTRAINT "map_report_relay_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
