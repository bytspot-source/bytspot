-- Soft account deletion with a fixed grace period.
-- Additive and nullable: existing rows stay active (deleted_at IS NULL).
--
-- Written to be re-runnable. The first attempt against production failed
-- part-way (P3009), so this migration has to survive being replayed over a
-- database where some of its own statements already succeeded.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "purge_after" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletion_reason" TEXT;

-- The purge job scans for due rows; partial index keeps that off the hot path
-- for the overwhelming majority of users, which are never deleted.
CREATE INDEX IF NOT EXISTS "User_purge_after_idx" ON "User" ("purge_after") WHERE "deleted_at" IS NOT NULL;
