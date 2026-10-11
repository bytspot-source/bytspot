-- AlterTable
ALTER TABLE "users" ADD COLUMN "invite_code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_invite_code_key" ON "users"("invite_code");
