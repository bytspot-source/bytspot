-- Store only SHA-256 digests of opaque attendee QR credentials.
-- A conditional check-in update uses checked_in_at as its replay guard.
ALTER TABLE "party_guests"
  ADD COLUMN "attendee_credential_hash" TEXT,
  ADD COLUMN "checked_in_at" TIMESTAMP(3);

CREATE INDEX "party_guests_party_id_attendee_credential_hash_idx"
  ON "party_guests"("party_id", "attendee_credential_hash");
