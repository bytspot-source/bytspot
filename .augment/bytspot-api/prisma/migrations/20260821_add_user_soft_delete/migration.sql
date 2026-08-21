-- Soft account deletion with a fixed grace period.
-- Additive and nullable: existing rows stay active (deleted_at IS NULL).
ALTER TABLE "User" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "purge_after" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletion_reason" TEXT;

-- The purge job scans for due rows; partial index keeps that off the hot path
-- for the overwhelming majority of users, which are never deleted.
CREATE INDEX "User_purge_after_idx" ON "User" ("purge_after") WHERE "deleted_at" IS NOT NULL;
