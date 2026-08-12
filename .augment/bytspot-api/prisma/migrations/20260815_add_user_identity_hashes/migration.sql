-- Member identity hashes: salted SHA-256 of each user's own auth-verified
-- identifiers. Only the signup email is hashed today; the 'phone' kind is
-- reserved until a phone-verification flow exists (unverified numbers would
-- enable discovery impersonation). Enables "this contact is on Bytspot"
-- discovery without requiring the other member to sync contacts.
-- Raw identifiers are never stored here. Existing members are backfilled
-- at server startup (the salt is not available at migration time).
CREATE TABLE "user_identity_hashes" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "hashed_identity" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_identity_hashes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_identity_hashes_kind_check" CHECK ("kind" IN ('email', 'phone'))
);

CREATE UNIQUE INDEX "user_identity_hashes_user_id_hashed_identity_key" ON "user_identity_hashes"("user_id", "hashed_identity");
CREATE INDEX "user_identity_hashes_hashed_identity_idx" ON "user_identity_hashes"("hashed_identity");

ALTER TABLE "user_identity_hashes"
  ADD CONSTRAINT "user_identity_hashes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
