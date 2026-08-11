-- Repair/assert People You Met invariants for databases that recorded the
-- original 20260815 migration before its partial-schema hardening. A malformed
-- partial schema or data violating any invariant fails this transaction; this
-- migration never deletes or rewrites privacy-sensitive records.
DO $$
DECLARE
  required_table TEXT;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'party_meet_consents', 'party_meet_exchanges', 'party_meet_connections',
    'user_blocks', 'party_meet_reports'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'People You Met repair requires table %', required_table;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_pkey') THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_party_id_user_id_key') THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_party_id_user_id_key" UNIQUE ("party_id", "user_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_party_id_fkey') THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_user_id_fkey') THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_pkey') THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_code_hash_key') THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_code_hash_key" UNIQUE ("code_hash");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_party_id_fkey') THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_issuer_user_id_fkey') THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_issuer_user_id_fkey" FOREIGN KEY ("issuer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_consent_id_fkey') THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "party_meet_consents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_redeemed_by_id_fkey') THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_redeemed_by_id_fkey" FOREIGN KEY ("redeemed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_pkey') THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_party_id_user_low_id_user_high_id_key') THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_party_id_user_low_id_user_high_id_key" UNIQUE ("party_id", "user_low_id", "user_high_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_canonical_pair_check') THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_canonical_pair_check" CHECK ("user_low_id" < "user_high_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_party_id_fkey') THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_user_low_id_fkey') THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_user_low_id_fkey" FOREIGN KEY ("user_low_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_user_high_id_fkey') THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_user_high_id_fkey" FOREIGN KEY ("user_high_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_pkey') THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_blocker_user_id_blocked_user_id_key') THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_user_id_blocked_user_id_key" UNIQUE ("blocker_user_id", "blocked_user_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_not_self_check') THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_not_self_check" CHECK ("blocker_user_id" <> "blocked_user_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_blocker_user_id_fkey') THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_user_id_fkey" FOREIGN KEY ("blocker_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_blocked_user_id_fkey') THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_pkey') THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_connection_id_fkey') THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "party_meet_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_reporter_user_id_fkey') THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_reported_user_id_fkey') THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "party_meet_consents_user_id_expires_at_idx" ON "party_meet_consents"("user_id", "expires_at");
CREATE INDEX IF NOT EXISTS "party_meet_consents_party_id_expires_at_idx" ON "party_meet_consents"("party_id", "expires_at");
CREATE INDEX IF NOT EXISTS "party_meet_exchanges_party_id_issuer_user_id_expires_at_idx" ON "party_meet_exchanges"("party_id", "issuer_user_id", "expires_at");
CREATE INDEX IF NOT EXISTS "party_meet_exchanges_consent_id_expires_at_idx" ON "party_meet_exchanges"("consent_id", "expires_at");
CREATE INDEX IF NOT EXISTS "party_meet_connections_user_low_id_expires_at_idx" ON "party_meet_connections"("user_low_id", "expires_at");
CREATE INDEX IF NOT EXISTS "party_meet_connections_user_high_id_expires_at_idx" ON "party_meet_connections"("user_high_id", "expires_at");
CREATE INDEX IF NOT EXISTS "user_blocks_blocked_user_id_idx" ON "user_blocks"("blocked_user_id");
CREATE INDEX IF NOT EXISTS "party_meet_reports_reporter_user_id_created_at_idx" ON "party_meet_reports"("reporter_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "party_meet_reports_reported_user_id_created_at_idx" ON "party_meet_reports"("reported_user_id", "created_at");
