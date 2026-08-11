-- Repair/assert People You Met invariants for databases that recorded the
-- original 20260815 migration before its partial-schema hardening. A malformed
-- partial schema or data violating any invariant fails this transaction; this
-- migration never deletes or rewrites privacy-sensitive records.
DO $$
DECLARE
  required_table TEXT;
  column_spec RECORD;
  default_spec RECORD;
  actual_default TEXT;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'party_meet_consents', 'party_meet_exchanges', 'party_meet_connections',
    'user_blocks', 'party_meet_reports'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'People You Met repair requires table %', required_table;
    END IF;
  END LOOP;

  -- Do not repair only keys on an arbitrary look-alike table. Every field the
  -- application uses for consent expiry, revocation, closure, and reporting
  -- must exist with the declared Postgres type and nullability.
  FOR column_spec IN
    SELECT * FROM (VALUES
      ('party_meet_consents', 'id', 'text', false), ('party_meet_consents', 'party_id', 'text', false), ('party_meet_consents', 'user_id', 'text', false), ('party_meet_consents', 'checked_in_at', 'timestamp', false), ('party_meet_consents', 'opted_in_at', 'timestamp', false), ('party_meet_consents', 'expires_at', 'timestamp', false), ('party_meet_consents', 'withdrawn_at', 'timestamp', true), ('party_meet_consents', 'created_at', 'timestamp', false), ('party_meet_consents', 'updated_at', 'timestamp', false),
      ('party_meet_exchanges', 'id', 'text', false), ('party_meet_exchanges', 'party_id', 'text', false), ('party_meet_exchanges', 'issuer_user_id', 'text', false), ('party_meet_exchanges', 'consent_id', 'text', false), ('party_meet_exchanges', 'code_hash', 'text', false), ('party_meet_exchanges', 'expires_at', 'timestamp', false), ('party_meet_exchanges', 'redeemed_at', 'timestamp', true), ('party_meet_exchanges', 'redeemed_by_id', 'text', true), ('party_meet_exchanges', 'revoked_at', 'timestamp', true), ('party_meet_exchanges', 'created_at', 'timestamp', false),
      ('party_meet_connections', 'id', 'text', false), ('party_meet_connections', 'party_id', 'text', false), ('party_meet_connections', 'user_low_id', 'text', false), ('party_meet_connections', 'user_high_id', 'text', false), ('party_meet_connections', 'expires_at', 'timestamp', false), ('party_meet_connections', 'deleted_at', 'timestamp', true), ('party_meet_connections', 'closed_at', 'timestamp', true), ('party_meet_connections', 'created_at', 'timestamp', false), ('party_meet_connections', 'updated_at', 'timestamp', false),
      ('user_blocks', 'id', 'text', false), ('user_blocks', 'blocker_user_id', 'text', false), ('user_blocks', 'blocked_user_id', 'text', false), ('user_blocks', 'created_at', 'timestamp', false),
      ('party_meet_reports', 'id', 'text', false), ('party_meet_reports', 'connection_id', 'text', false), ('party_meet_reports', 'reporter_user_id', 'text', false), ('party_meet_reports', 'reported_user_id', 'text', false), ('party_meet_reports', 'reason', 'PartyMeetReportReason', false), ('party_meet_reports', 'details', 'text', true), ('party_meet_reports', 'created_at', 'timestamp', false)
    ) AS expected(table_name, column_name, udt_name, is_nullable)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = column_spec.table_name
        AND c.column_name = column_spec.column_name AND c.udt_name = column_spec.udt_name
        AND (c.is_nullable = 'YES') = column_spec.is_nullable
    ) THEN
      RAISE EXCEPTION 'People You Met repair requires %.% with type % and nullable=%', column_spec.table_name, column_spec.column_name, column_spec.udt_name, column_spec.is_nullable;
    END IF;
  END LOOP;

  FOR default_spec IN
    SELECT * FROM (VALUES
      ('party_meet_consents', 'opted_in_at'), ('party_meet_consents', 'created_at'), ('party_meet_consents', 'updated_at'),
      ('party_meet_exchanges', 'created_at'), ('party_meet_connections', 'created_at'), ('party_meet_connections', 'updated_at'),
      ('user_blocks', 'created_at'), ('party_meet_reports', 'created_at')
    ) AS expected(table_name, column_name)
  LOOP
    SELECT pg_get_expr(d.adbin, d.adrelid) INTO actual_default
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = ('public.' || default_spec.table_name)::regclass AND a.attname = default_spec.column_name;
    IF actual_default IS NULL OR lower(actual_default) NOT LIKE '%current_timestamp%' THEN
      RAISE EXCEPTION 'People You Met repair requires CURRENT_TIMESTAMP default on %.%', default_spec.table_name, default_spec.column_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'PartyMeetReportReason')
     OR (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typnamespace = 'public'::regnamespace AND t.typname = 'PartyMeetReportReason')
        IS DISTINCT FROM ARRAY['harassment', 'safety', 'impersonation', 'spam', 'other']::name[] THEN
    RAISE EXCEPTION 'People You Met repair requires the PartyMeetReportReason enum contract';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_pkey' AND conrelid = 'public.party_meet_consents'::regclass) THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_party_id_user_id_key' AND conrelid = 'public.party_meet_consents'::regclass) THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_party_id_user_id_key" UNIQUE ("party_id", "user_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_party_id_fkey' AND conrelid = 'public.party_meet_consents'::regclass) THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_consents_user_id_fkey' AND conrelid = 'public.party_meet_consents'::regclass) THEN
    ALTER TABLE "party_meet_consents" ADD CONSTRAINT "party_meet_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_pkey' AND conrelid = 'public.party_meet_exchanges'::regclass) THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_code_hash_key' AND conrelid = 'public.party_meet_exchanges'::regclass) THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_code_hash_key" UNIQUE ("code_hash");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_party_id_fkey' AND conrelid = 'public.party_meet_exchanges'::regclass) THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_issuer_user_id_fkey' AND conrelid = 'public.party_meet_exchanges'::regclass) THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_issuer_user_id_fkey" FOREIGN KEY ("issuer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_consent_id_fkey' AND conrelid = 'public.party_meet_exchanges'::regclass) THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "party_meet_consents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_exchanges_redeemed_by_id_fkey' AND conrelid = 'public.party_meet_exchanges'::regclass) THEN
    ALTER TABLE "party_meet_exchanges" ADD CONSTRAINT "party_meet_exchanges_redeemed_by_id_fkey" FOREIGN KEY ("redeemed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_pkey' AND conrelid = 'public.party_meet_connections'::regclass) THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_party_id_user_low_id_user_high_id_key' AND conrelid = 'public.party_meet_connections'::regclass) THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_party_id_user_low_id_user_high_id_key" UNIQUE ("party_id", "user_low_id", "user_high_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_canonical_pair_check' AND conrelid = 'public.party_meet_connections'::regclass) THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_canonical_pair_check" CHECK ("user_low_id" < "user_high_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_party_id_fkey' AND conrelid = 'public.party_meet_connections'::regclass) THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_user_low_id_fkey' AND conrelid = 'public.party_meet_connections'::regclass) THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_user_low_id_fkey" FOREIGN KEY ("user_low_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_connections_user_high_id_fkey' AND conrelid = 'public.party_meet_connections'::regclass) THEN
    ALTER TABLE "party_meet_connections" ADD CONSTRAINT "party_meet_connections_user_high_id_fkey" FOREIGN KEY ("user_high_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_pkey' AND conrelid = 'public.user_blocks'::regclass) THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_blocker_user_id_blocked_user_id_key' AND conrelid = 'public.user_blocks'::regclass) THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_user_id_blocked_user_id_key" UNIQUE ("blocker_user_id", "blocked_user_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_not_self_check' AND conrelid = 'public.user_blocks'::regclass) THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_not_self_check" CHECK ("blocker_user_id" <> "blocked_user_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_blocker_user_id_fkey' AND conrelid = 'public.user_blocks'::regclass) THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_user_id_fkey" FOREIGN KEY ("blocker_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocks_blocked_user_id_fkey' AND conrelid = 'public.user_blocks'::regclass) THEN
    ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_pkey' AND conrelid = 'public.party_meet_reports'::regclass) THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_pkey" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_connection_id_fkey' AND conrelid = 'public.party_meet_reports'::regclass) THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "party_meet_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_reporter_user_id_fkey' AND conrelid = 'public.party_meet_reports'::regclass) THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_meet_reports_reported_user_id_fkey' AND conrelid = 'public.party_meet_reports'::regclass) THEN
    ALTER TABLE "party_meet_reports" ADD CONSTRAINT "party_meet_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- A constraint name is not sufficient evidence of the privacy contract. Check
-- each repaired object is the expected key/check/foreign-key definition on its
-- intended table (including the cascade policy used for account erasure).
DO $$
DECLARE
  expected RECORD;
  actual_definition TEXT;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('party_meet_consents', 'party_meet_consents_pkey', '^primarykey[(]id[)]$'),
      ('party_meet_consents', 'party_meet_consents_party_id_user_id_key', '^unique[(]party_id,user_id[)]$'),
      ('party_meet_consents', 'party_meet_consents_party_id_fkey', '^foreignkey[(]party_id[)]references([p]ublic[.])?parties[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_consents', 'party_meet_consents_user_id_fkey', '^foreignkey[(]user_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_exchanges', 'party_meet_exchanges_pkey', '^primarykey[(]id[)]$'),
      ('party_meet_exchanges', 'party_meet_exchanges_code_hash_key', '^unique[(]code_hash[)]$'),
      ('party_meet_exchanges', 'party_meet_exchanges_party_id_fkey', '^foreignkey[(]party_id[)]references([p]ublic[.])?parties[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_exchanges', 'party_meet_exchanges_issuer_user_id_fkey', '^foreignkey[(]issuer_user_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_exchanges', 'party_meet_exchanges_consent_id_fkey', '^foreignkey[(]consent_id[)]references([p]ublic[.])?party_meet_consents[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_exchanges', 'party_meet_exchanges_redeemed_by_id_fkey', '^foreignkey[(]redeemed_by_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondelete(setnull)?$'),
      ('party_meet_connections', 'party_meet_connections_pkey', '^primarykey[(]id[)]$'),
      ('party_meet_connections', 'party_meet_connections_party_id_user_low_id_user_high_id_key', '^unique[(]party_id,user_low_id,user_high_id[)]$'),
      ('party_meet_connections', 'party_meet_connections_canonical_pair_check', '^check[(][(]user_low_id<user_high_id[)][)]$'),
      ('party_meet_connections', 'party_meet_connections_party_id_fkey', '^foreignkey[(]party_id[)]references([p]ublic[.])?parties[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_connections', 'party_meet_connections_user_low_id_fkey', '^foreignkey[(]user_low_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_connections', 'party_meet_connections_user_high_id_fkey', '^foreignkey[(]user_high_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$'),
      ('user_blocks', 'user_blocks_pkey', '^primarykey[(]id[)]$'),
      ('user_blocks', 'user_blocks_blocker_user_id_blocked_user_id_key', '^unique[(]blocker_user_id,blocked_user_id[)]$'),
      ('user_blocks', 'user_blocks_not_self_check', '^check[(][(]blocker_user_id<>blocked_user_id[)][)]$'),
      ('user_blocks', 'user_blocks_blocker_user_id_fkey', '^foreignkey[(]blocker_user_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$'),
      ('user_blocks', 'user_blocks_blocked_user_id_fkey', '^foreignkey[(]blocked_user_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_reports', 'party_meet_reports_pkey', '^primarykey[(]id[)]$'),
      ('party_meet_reports', 'party_meet_reports_connection_id_fkey', '^foreignkey[(]connection_id[)]references([p]ublic[.])?party_meet_connections[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_reports', 'party_meet_reports_reporter_user_id_fkey', '^foreignkey[(]reporter_user_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$'),
      ('party_meet_reports', 'party_meet_reports_reported_user_id_fkey', '^foreignkey[(]reported_user_id[)]references([p]ublic[.])?users[(]id[)]onupdatecascadeondeletecascade$')
    ) AS contract(table_name, constraint_name, definition_pattern)
  LOOP
    SELECT lower(regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')) INTO actual_definition
    FROM pg_constraint c
    WHERE c.conname = expected.constraint_name
      AND c.conrelid = ('public.' || expected.table_name)::regclass;
    IF actual_definition IS NULL OR actual_definition !~ replace(expected.definition_pattern, '\\', '\') THEN
      RAISE EXCEPTION 'People You Met repair found invalid constraint %.%: %', expected.table_name, expected.constraint_name, actual_definition;
    END IF;
  END LOOP;
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
