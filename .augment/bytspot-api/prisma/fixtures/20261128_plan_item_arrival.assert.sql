-- Disposable migration-fixture database ONLY. These assertions always roll back.
--
-- The columns are nullable, defaultless facts. The migration must not invent
-- a venue or a time for a row that did not state one. Deleting a venue clears
-- the pointer and leaves the Plan item in place.
BEGIN;
DO $$
DECLARE
  u_id TEXT := 'fixture-n1-user';
  -- Not named plan_id or venue_id: those are columns, and a variable of the
  -- same name makes every reference in this block ambiguous.
  plan_row TEXT := 'fixture-n1-plan';
  venue_row TEXT := 'fixture-n1-venue';
  got INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM plan_items WHERE plan_items.venue_id IS NOT NULL OR plan_items.arrives_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'migration filled a venue or arrival the writer did not state';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_items'
      AND column_name = 'venue_id' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'plan_items.venue_id must be nullable with no default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_items'
      AND column_name = 'arrives_at' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'plan_items.arrives_at must be nullable with no default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'plan_items' AND indexname = 'plan_items_venue_id_arrives_at_idx'
  ) THEN
    RAISE EXCEPTION 'plan_items_venue_id_arrives_at_idx missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_name = 'plan_items_venue_id_fkey' AND delete_rule = 'SET NULL'
  ) THEN
    RAISE EXCEPTION 'plan_items.venue_id must reference venues and set null on delete';
  END IF;

  INSERT INTO users (id, email, password, created_at, updated_at)
  VALUES (u_id, 'fixture-n1@bytspot.test', 'fixture-placeholder-not-a-credential', now(), now());

  INSERT INTO plans (id, creator_user_id, idempotency_key, title, intent, join_token, created_at, updated_at)
  VALUES (plan_row, u_id, 'fixture-n1-key', 'N1', 'N1', 'fixture-n1-token', now(), now());

  INSERT INTO venues (id, name, slug, address, lat, lng, category)
  VALUES (venue_row, 'Fixture Room', 'fixture-n1-venue', '1 Main St', 33.7, -84.4, 'bar');

  -- A writer that has never heard of the columns still inserts, and both
  -- facts stay unstated rather than becoming a guessed stop.
  INSERT INTO plan_items (id, plan_id, need_kind, title, created_at, updated_at)
  VALUES ('fixture-n1-unstated', plan_row, 'dining', 'Unstated', now(), now());

  SELECT count(*) INTO got FROM plan_items
  WHERE id = 'fixture-n1-unstated' AND plan_items.venue_id IS NULL AND plan_items.arrives_at IS NULL;
  IF got <> 1 THEN
    RAISE EXCEPTION 'an insert that states no stop did not keep both facts null';
  END IF;

  INSERT INTO plan_items (id, plan_id, need_kind, title, venue_id, arrives_at, created_at, updated_at)
  VALUES ('fixture-n1-stated', plan_row, 'dining', 'Stated', venue_row, TIMESTAMP '2026-12-04 23:00:00', now(), now());

  DELETE FROM venues WHERE id = venue_row;

  IF NOT EXISTS (SELECT 1 FROM plan_items WHERE id = 'fixture-n1-stated') THEN
    RAISE EXCEPTION 'deleting a venue must not delete the plan item';
  END IF;
  IF (SELECT plan_items.venue_id FROM plan_items WHERE id = 'fixture-n1-stated') IS NOT NULL THEN
    RAISE EXCEPTION 'deleting a venue must clear the stop pointer';
  END IF;
  IF (SELECT plan_items.arrives_at FROM plan_items WHERE id = 'fixture-n1-stated') IS NULL THEN
    RAISE EXCEPTION 'clearing the venue must not forget the arrival time';
  END IF;

  BEGIN
    INSERT INTO plan_items (id, plan_id, need_kind, title, venue_id, created_at, updated_at)
    VALUES ('fixture-n1-missing', plan_row, 'dining', 'Missing', 'no-such-venue', now(), now());
    RAISE EXCEPTION 'a stop was filed against a venue that does not exist';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
