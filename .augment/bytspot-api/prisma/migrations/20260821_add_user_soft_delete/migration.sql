-- Soft account deletion with a fixed grace period.
-- Additive and nullable: existing rows stay active (deleted_at IS NULL).
--
-- The table is "users": the User model carries @@map("users"), as every other
-- table in this schema does. Naming it "User" is what failed this migration in
-- production on 2026-08-21.
--
-- Written to be re-runnable, because the failed attempt has to be replayed
-- over a database where some of these statements may already have succeeded.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "purge_after" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_reason" TEXT;

-- The purge job scans for due rows; partial index keeps that off the hot path
-- for the overwhelming majority of users, which are never deleted.
CREATE INDEX IF NOT EXISTS "users_purge_after_idx" ON "users" ("purge_after") WHERE "deleted_at" IS NOT NULL;
