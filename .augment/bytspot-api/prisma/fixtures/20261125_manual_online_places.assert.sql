-- Disposable migration-fixture database ONLY. These assertions always roll back.
BEGIN;
DO $$
DECLARE v TEXT := 'fixture-manual-online';
BEGIN
  IF EXISTS (SELECT 1 FROM venues WHERE online_only OR website IS NOT NULL OR verification_note IS NOT NULL OR verified_at IS NOT NULL)
  THEN RAISE EXCEPTION 'migration invented an online flag or verification for an existing venue'; END IF;
  INSERT INTO venues (id, name, slug, address, lat, lng, category) VALUES (v, 'Fixture', v, '1 Main St', 33.7, -84.4, 'service');
  IF (SELECT online_only FROM venues WHERE id = v) THEN RAISE EXCEPTION 'a new venue starts online-only'; END IF;
  BEGIN
    UPDATE venues SET website = 'http://example.com' WHERE id = v;
    RAISE EXCEPTION 'a non-https website was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE venues SET verification_note = repeat('x', 1001) WHERE id = v;
    RAISE EXCEPTION 'an over-long verification note was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
