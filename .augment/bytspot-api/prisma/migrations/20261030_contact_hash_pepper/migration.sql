-- Existing rows hold the client's salted hash and are marked unkeyed; the API
-- rekeys them with CONTACT_HASH_PEPPER at startup. New rows are keyed on write.
ALTER TABLE "contact_hashes" ADD COLUMN "keyed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "contact_hashes" ALTER COLUMN "keyed" SET DEFAULT true;

ALTER TABLE "user_identity_hashes" ADD COLUMN "keyed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_identity_hashes" ALTER COLUMN "keyed" SET DEFAULT true;
