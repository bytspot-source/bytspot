-- Party coordinates are what admits a Party to a geographic surface, so this
-- fixture asserts the closed side holds: existing rows keep NULL without a
-- backfill, half a coordinate is unstorable, off-Earth and 0/0 placeholders
-- are unstorable, and the partial discovery index exists.
DO $$
DECLARE
  p_id TEXT;
  host_id TEXT;
  non_null_count INT;
BEGIN
  IF to_regclass('public.parties') IS NULL THEN
    RAISE EXCEPTION 'parties table missing';
  END IF;

  -- Both columns must exist and must be nullable. A NOT NULL coordinate would
  -- have required a backfill, and there is no honest value to backfill with.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'parties' AND column_name = 'lat' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'parties.lat missing or not nullable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'parties' AND column_name = 'lng' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'parties.lng missing or not nullable';
  END IF;

  -- The migration invents no locations. Every pre-existing row stays unlocated.
  SELECT count(*) INTO non_null_count FROM parties WHERE lat IS NOT NULL OR lng IS NOT NULL;
  IF non_null_count <> 0 THEN
    RAISE EXCEPTION 'migration invented coordinates on % existing parties', non_null_count;
  END IF;

  SELECT id INTO host_id FROM users LIMIT 1;
  IF host_id IS NULL THEN
    INSERT INTO users (id, email, password, created_at, updated_at)
    VALUES ('fixture-coord-host', 'fixture-coord-host@bytspot.test', 'fixture-placeholder-not-a-credential', now(), now())
    RETURNING id INTO host_id;
  END IF;

  INSERT INTO parties (
    id, host_user_id, idempotency_key, template_id, title, tagline,
    starts_at, venue_name, capacity, access_mode, required_membership_tier,
    itinerary, ticket_tiers, cohosts, template_config, status,
    created_at, updated_at
  ) VALUES (
    'fixture-coord-party', host_id, 'fixture-coord-key', 'dinner', 'Fixture', 'Fixture',
    now() + interval '1 day', 'Fixture Venue', 10, 'free-rsvp', 'green',
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'draft',
    now(), now()
  ) RETURNING id INTO p_id;

  -- A real coordinate must store.
  UPDATE parties SET lat = 33.7866, lng = -84.3833 WHERE id = p_id;

  -- Half a coordinate is not a location.
  BEGIN
    UPDATE parties SET lat = 33.7866, lng = NULL WHERE id = p_id;
    RAISE EXCEPTION 'parties accepted a latitude with no longitude';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE parties SET lat = NULL, lng = -84.3833 WHERE id = p_id;
    RAISE EXCEPTION 'parties accepted a longitude with no latitude';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- Clearing both together must remain allowed: a host may unset a location.
  UPDATE parties SET lat = NULL, lng = NULL WHERE id = p_id;

  -- Off-Earth coordinates are unstorable.
  BEGIN
    UPDATE parties SET lat = 91, lng = 0.5 WHERE id = p_id;
    RAISE EXCEPTION 'parties accepted a latitude beyond the pole';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE parties SET lat = 33.7866, lng = 181 WHERE id = p_id;
    RAISE EXCEPTION 'parties accepted a longitude beyond the meridian';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- 0/0 is the unresolved placeholder, not a location in the Gulf of Guinea.
  BEGIN
    UPDATE parties SET lat = 0, lng = 0 WHERE id = p_id;
    RAISE EXCEPTION 'parties accepted the 0/0 placeholder as a location';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- The surface that reads these columns needs its index.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'parties' AND indexname = 'parties_discovery_location_idx'
  ) THEN
    RAISE EXCEPTION 'parties_discovery_location_idx missing';
  END IF;

  DELETE FROM parties WHERE id = p_id;
  DELETE FROM users WHERE id = 'fixture-coord-host';
END $$;
