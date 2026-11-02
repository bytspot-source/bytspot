-- Disposable migration-fixture database ONLY. These assertions always roll back.
BEGIN;
DO $$
DECLARE u TEXT := 'fixture-pref-filters';
BEGIN
  IF EXISTS (SELECT 1 FROM user_preferences WHERE cardinality(avoid) > 0 OR price_ceiling IS NOT NULL)
  THEN RAISE EXCEPTION 'migration invented a preference filter for an existing member'; END IF;
  INSERT INTO users (id, email, password, updated_at)
    VALUES (u, 'fixture-pref-filters@bytspot.test', 'fixture-not-a-real-hash', NOW());
  INSERT INTO user_preferences (id, user_id, updated_at) VALUES (u, u, NOW());
  IF (SELECT cardinality(avoid) FROM user_preferences WHERE id = u) <> 0
    OR (SELECT price_ceiling FROM user_preferences WHERE id = u) IS NOT NULL
  THEN RAISE EXCEPTION 'new preferences filter something by default'; END IF;
  UPDATE user_preferences SET avoid = ARRAY['nightclubs', 'busy'], price_ceiling = 2 WHERE id = u;
  BEGIN
    UPDATE user_preferences SET avoid = ARRAY['loud'] WHERE id = u;
    RAISE EXCEPTION 'unknown avoid tag accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE user_preferences SET price_ceiling = 5 WHERE id = u;
    RAISE EXCEPTION 'price ceiling above 4 accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE user_preferences SET price_ceiling = 0 WHERE id = u;
    RAISE EXCEPTION 'price ceiling below 1 accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
