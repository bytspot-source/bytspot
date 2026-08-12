-- Party Control: hosts can pause new admissions, and each admitted guest can
-- hold one opaque bearer credential (32 random bytes, base64url) that Door
-- Mode consumes exactly once at check-in.
ALTER TABLE "parties"
  ADD COLUMN "admission_paused" BOOLEAN NOT NULL DEFAULT false;

-- Optional explicit end time. Post-event surfaces (People You Met) fall back
-- to starts_at + 6 hours when ends_at is NULL.
ALTER TABLE "parties"
  ADD COLUMN "ends_at" TIMESTAMP(3);

ALTER TABLE "party_guests"
  ADD COLUMN "credential" TEXT,
  ADD COLUMN "checked_in_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "party_guests_credential_key" ON "party_guests"("credential");
