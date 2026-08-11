-- CreateEnum
CREATE TYPE "IOSPushEnvironment" AS ENUM ('production', 'sandbox');

-- CreateTable
CREATE TABLE "ios_push_devices" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "environment" "IOSPushEnvironment" NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidated_at" TIMESTAMP(3),

    CONSTRAINT "ios_push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ios_push_devices_token_key" ON "ios_push_devices"("token");
CREATE INDEX "ios_push_devices_user_id_invalidated_at_idx" ON "ios_push_devices"("user_id", "invalidated_at");

-- AddForeignKey
ALTER TABLE "ios_push_devices" ADD CONSTRAINT "ios_push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
