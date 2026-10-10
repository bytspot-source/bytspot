-- Member email verification. Apple and Google accounts arrive with a
-- provider-verified email, so they are verified from creation. Password
-- accounts were never checked, so their email leaves contact discovery until
-- the member confirms a code.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);

UPDATE "users" u
SET "email_verified_at" = u."created_at"
WHERE EXISTS (SELECT 1 FROM "provider_identities" p WHERE p."user_id" = u."id");

DELETE FROM "user_identity_hashes" h
USING "users" u
WHERE h."user_id" = u."id"
  AND h."kind" = 'email'
  AND u."email_verified_at" IS NULL;
