-- Whether an account has a password its member chose. Apple/Google accounts
-- and vendor invitees were given a generated secret nobody knows, so only the
-- remaining accounts are marked as having one.
ALTER TABLE "users" ADD COLUMN "password_set_at" TIMESTAMP(3);

UPDATE "users" u
SET "password_set_at" = u."created_at"
WHERE NOT EXISTS (SELECT 1 FROM "provider_identities" p WHERE p."user_id" = u."id")
  AND u."ref" IS DISTINCT FROM 'vendor-invite';
