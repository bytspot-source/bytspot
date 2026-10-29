-- Disposable migration-fixture database ONLY. These assertions always roll back.
BEGIN;
DO $$
DECLARE t TEXT; keyed_rows INT;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact_hashes', 'user_identity_hashes'] LOOP
    -- Every row that existed before the migration still holds a client hash.
    EXECUTE format('SELECT count(*) FROM %I WHERE keyed', t) INTO keyed_rows;
    IF keyed_rows > 0 THEN RAISE EXCEPTION '% marked a pre-pepper row as keyed', t; END IF;
    IF (SELECT column_default FROM information_schema.columns WHERE table_name = t AND column_name = 'keyed') <> 'true'
      OR (SELECT is_nullable FROM information_schema.columns WHERE table_name = t AND column_name = 'keyed') <> 'NO'
    THEN RAISE EXCEPTION '% new rows must default to keyed', t; END IF;
  END LOOP;
END $$;
ROLLBACK;
