-- Disposable migration-fixture database ONLY. These assertions always roll back.
BEGIN;
DO $$
DECLARE s TEXT := 'fixture-admin-controls';
BEGIN
  IF EXISTS (SELECT 1 FROM vendor_sellers WHERE paused_at IS NOT NULL OR closed_at IS NOT NULL OR created_by_user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'migration invented an admin decision for an existing business'; END IF;
  INSERT INTO vendor_sellers (id, updated_at) VALUES (s, NOW());
  IF (SELECT paused_at FROM vendor_sellers WHERE id = s) IS NOT NULL
  THEN RAISE EXCEPTION 'a new business starts paused'; END IF;
  BEGIN
    UPDATE vendor_sellers SET paused_reason = repeat('x', 501) WHERE id = s;
    RAISE EXCEPTION 'an over-long pause reason was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
