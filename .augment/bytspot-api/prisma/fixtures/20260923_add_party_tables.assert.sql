-- Tables are the first thing in a Party that takes seats under a race, so
-- this fixture asserts the closed side holds where it matters: the database
-- refuses an oversold table rather than trusting the writer, a guarded
-- increment loses safely, removing a table unseats a guest instead of
-- deleting them, and deleting the Party still takes its tables with it.
DO $$
DECLARE
  u_id TEXT := 'fixture-table-user';
  p_id TEXT := 'fixture-table-party';
  s_one TEXT := 'fixture-table-first';
  s_two TEXT := 'fixture-table-second';
  g_id TEXT := 'fixture-table-guest';
  got INT;
  still_there TEXT;
BEGIN
  IF to_regclass('public.party_tables') IS NULL THEN
    RAISE EXCEPTION 'party_tables table missing';
  END IF;

  INSERT INTO users (id, email, password, created_at, updated_at)
  VALUES (u_id, 'fixture-table@bytspot.test', 'fixture-placeholder-not-a-credential', now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO parties (
    id, host_user_id, idempotency_key, template_id, title, tagline, starts_at,
    venue_name, capacity, access_mode, required_membership_tier, itinerary,
    ticket_tiers, cohosts, template_config, status, created_at, updated_at
  ) VALUES (
    p_id, u_id, 'fixture-table-key', 'listening-party', 'Tables', 'One evening, two doors',
    now() + interval '1 day', 'Fixture Room', 80, 'paid-ticket', 'green', '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '{"kind":"listening-party"}'::jsonb, 'published', now(), now()
  );

  INSERT INTO party_tables (id, party_id, name, starts_at, ends_at, capacity, committed, price_cents, "position", updated_at)
  VALUES
    (s_one, p_id, 'First Seating',  now() + interval '1 day',                      now() + interval '1 day' + interval '2 hours', 40, 0, 2500, 0, now()),
    (s_two, p_id, 'Second Seating', now() + interval '1 day' + interval '3 hours', now() + interval '1 day' + interval '5 hours', 40, 0, 2500, 1, now());

  -- A table that holds nobody is not a table.
  BEGIN
    INSERT INTO party_tables (id, party_id, name, starts_at, ends_at, capacity, "position", updated_at)
    VALUES ('fixture-table-empty', p_id, 'Empty', now() + interval '1 day', now() + interval '1 day' + interval '1 hour', 0, 9, now());
    RAISE EXCEPTION 'a table with zero capacity was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A window that ends before it starts is not a window.
  BEGIN
    INSERT INTO party_tables (id, party_id, name, starts_at, ends_at, capacity, "position", updated_at)
    VALUES ('fixture-table-backwards', p_id, 'Backwards', now() + interval '2 days', now() + interval '1 day', 10, 8, now());
    RAISE EXCEPTION 'a table ending before it starts was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Two tables cannot occupy the same place in the running order.
  BEGIN
    INSERT INTO party_tables (id, party_id, name, starts_at, ends_at, capacity, "position", updated_at)
    VALUES ('fixture-table-clash', p_id, 'Clash', now() + interval '1 day', now() + interval '1 day' + interval '1 hour', 10, 0, now());
    RAISE EXCEPTION 'two tables shared position 0';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- ─── The guarded increment ────────────────────────────────────────────────
  -- This is the whole reason capacity lives on the row. The guard is the WHERE
  -- clause; the CHECK is what makes a missing guard impossible to get away
  -- with. Fill the table, then try to take one more seat both ways.

  UPDATE party_tables SET committed = committed + 40
  WHERE id = s_one AND committed + 40 <= capacity;

  SELECT committed INTO got FROM party_tables WHERE id = s_one;
  IF got <> 40 THEN
    RAISE EXCEPTION 'a guarded take of the whole table recorded % seats', got;
  END IF;

  -- A guarded writer that loses simply matches no row. Nothing is taken, and
  -- no error has to be caught for the seat to stay unsold.
  UPDATE party_tables SET committed = committed + 1
  WHERE id = s_one AND committed + 1 <= capacity;
  SELECT committed INTO got FROM party_tables WHERE id = s_one;
  IF got <> 40 THEN
    RAISE EXCEPTION 'a losing guarded take still moved committed to %', got;
  END IF;

  -- An unguarded writer is refused by the database, so the invariant does not
  -- depend on every caller remembering the WHERE clause.
  BEGIN
    UPDATE party_tables SET committed = committed + 1 WHERE id = s_one;
    RAISE EXCEPTION 'an unguarded take oversold the table';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- ─── Removing a table must not remove the guest ─────────────────────────

  INSERT INTO party_guests (id, party_id, user_id, status, access_granted, table_id, created_at, updated_at)
  VALUES (g_id, p_id, u_id, 'ticketed', true, s_two, now(), now());

  DELETE FROM party_tables WHERE id = s_two;

  SELECT status INTO still_there FROM party_guests WHERE id = g_id;
  IF still_there IS NULL THEN
    RAISE EXCEPTION 'deleting a table deleted the guest holding it';
  END IF;
  IF still_there <> 'ticketed' THEN
    RAISE EXCEPTION 'deleting a table changed the guest status to %', still_there;
  END IF;

  -- Unseated, and visibly so, rather than silently still holding a table
  -- that no longer exists.
  SELECT count(*) INTO got FROM party_guests WHERE id = g_id AND table_id IS NULL;
  IF got <> 1 THEN
    RAISE EXCEPTION 'a guest whose table was removed was not left unseated';
  END IF;

  -- ─── The Party still owns its tables ────────────────────────────────────

  DELETE FROM parties WHERE id = p_id;

  SELECT count(*) INTO got FROM party_tables WHERE party_id = p_id;
  IF got <> 0 THEN
    RAISE EXCEPTION 'deleting the Party left % orphaned table(s)', got;
  END IF;

  DELETE FROM users WHERE id = u_id;
END $$;
