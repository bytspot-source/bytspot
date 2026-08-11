-- People You Met is party-scoped and consent-only. It is not an attendee
-- directory or a social/follow graph. Do not silently accept partial schemas:
-- a prior failed/manual partial deployment must fail this migration loudly so
-- required privacy and race-safety constraints cannot be skipped.
DO $$ BEGIN
  CREATE TYPE "PartyMeetReportReason" AS ENUM ('harassment', 'safety', 'impersonation', 'spam', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "party_meet_consents" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "checked_in_at" TIMESTAMP(3) NOT NULL,
  "opted_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "withdrawn_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "party_meet_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_meet_consents_party_id_user_id_key" UNIQUE ("party_id", "user_id"),
  CONSTRAINT "party_meet_consents_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "party_meet_exchanges" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "issuer_user_id" TEXT NOT NULL,
  "consent_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "redeemed_at" TIMESTAMP(3),
  "redeemed_by_id" TEXT,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "party_meet_exchanges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_meet_exchanges_code_hash_key" UNIQUE ("code_hash"),
  CONSTRAINT "party_meet_exchanges_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_exchanges_issuer_user_id_fkey" FOREIGN KEY ("issuer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_exchanges_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "party_meet_consents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_exchanges_redeemed_by_id_fkey" FOREIGN KEY ("redeemed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "party_meet_connections" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_low_id" TEXT NOT NULL,
  "user_high_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "party_meet_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_meet_connections_party_id_user_low_id_user_high_id_key" UNIQUE ("party_id", "user_low_id", "user_high_id"),
  CONSTRAINT "party_meet_connections_canonical_pair_check" CHECK ("user_low_id" < "user_high_id"),
  CONSTRAINT "party_meet_connections_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_connections_user_low_id_fkey" FOREIGN KEY ("user_low_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_connections_user_high_id_fkey" FOREIGN KEY ("user_high_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "user_blocks" (
  "id" TEXT NOT NULL,
  "blocker_user_id" TEXT NOT NULL,
  "blocked_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_blocks_blocker_user_id_blocked_user_id_key" UNIQUE ("blocker_user_id", "blocked_user_id"),
  CONSTRAINT "user_blocks_not_self_check" CHECK ("blocker_user_id" <> "blocked_user_id"),
  CONSTRAINT "user_blocks_blocker_user_id_fkey" FOREIGN KEY ("blocker_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_blocks_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "party_meet_reports" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "reporter_user_id" TEXT NOT NULL,
  "reported_user_id" TEXT NOT NULL,
  "reason" "PartyMeetReportReason" NOT NULL,
  "details" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "party_meet_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_meet_reports_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "party_meet_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_meet_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "party_meet_consents_user_id_expires_at_idx" ON "party_meet_consents"("user_id", "expires_at");
CREATE INDEX "party_meet_consents_party_id_expires_at_idx" ON "party_meet_consents"("party_id", "expires_at");
CREATE INDEX "party_meet_exchanges_party_id_issuer_user_id_expires_at_idx" ON "party_meet_exchanges"("party_id", "issuer_user_id", "expires_at");
CREATE INDEX "party_meet_exchanges_consent_id_expires_at_idx" ON "party_meet_exchanges"("consent_id", "expires_at");
CREATE INDEX "party_meet_connections_user_low_id_expires_at_idx" ON "party_meet_connections"("user_low_id", "expires_at");
CREATE INDEX "party_meet_connections_user_high_id_expires_at_idx" ON "party_meet_connections"("user_high_id", "expires_at");
CREATE INDEX "user_blocks_blocked_user_id_idx" ON "user_blocks"("blocked_user_id");
CREATE INDEX "party_meet_reports_reporter_user_id_created_at_idx" ON "party_meet_reports"("reporter_user_id", "created_at");
CREATE INDEX "party_meet_reports_reported_user_id_created_at_idx" ON "party_meet_reports"("reported_user_id", "created_at");
