-- A checkout may buy a gate ticket, a table, or both, so this fixture asserts
-- the database still refuses the shapes that would lose money or lose a
-- guest's table: a charge for nothing, a table share larger than the charge
-- itself, and deleting a table out from under a checkout that references it.
DO $$
DECLARE
  u_id TEXT := 'fixture-checkout-user';
  p_id TEXT := 'fixture-checkout-party';
  t_id TEXT := 'fixture-checkout-table';
  g_id TEXT := 'fixture-checkout-guest';
  c_id TEXT := 'fixture-checkout-row';
  failed BOOLEAN;
BEGIN
  INSERT INTO "users" ("id", "email", "password", "created_at", "updated_at")
  VALUES (u_id, 'fixture-checkout@bytspot.test', 'fixture-placeholder-not-a-credential', now(), now())
  ON CONFLICT ("id") DO NOTHING;

  INSERT INTO "parties" (
    "id", "host_user_id", "idempotency_key", "template_id", "title", "tagline", "starts_at",
    "venue_name", "capacity", "access_mode", "required_membership_tier", "itinerary",
    "ticket_tiers", "cohosts", "template_config", "status", "created_at", "updated_at"
  ) VALUES (
    p_id, u_id, 'fixture-checkout-key', 'listening-party', 'Tables', 'Free door, paid tables',
    now() + interval '1 day', 'Fixture Room', 80, 'free-rsvp', 'green', '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '{"kind":"listening-party"}'::jsonb, 'published', now(), now()
  );

  INSERT INTO "party_tables" ("id", "party_id", "name", "starts_at", "ends_at", "capacity", "committed", "price_cents", "position", "updated_at")
  VALUES (t_id, p_id, 'Front Table', now() + interval '1 day', now() + interval '1 day 2 hours', 4, 0, 9000, 0, now());

  INSERT INTO "party_guests" ("id", "party_id", "user_id", "status", "access_granted", "updated_at")
  VALUES (g_id, p_id, u_id, 'checkout-pending', false, now());

  -- A free-entry Party sells a table with no gate ticket at all. This is the
  -- arrangement the old NOT NULL on ticket_tier_name made impossible.
  INSERT INTO "party_checkouts" (
    "id", "party_id", "party_guest_id", "user_id", "idempotency_key",
    "ticket_tier_name", "table_id", "amount_cents", "table_amount_cents",
    "currency", "status", "reservation_expires_at", "updated_at"
  ) VALUES (
    c_id, p_id, g_id, u_id, 'fixture-checkout-idem',
    NULL, t_id, 9000, 9000,
    'usd', 'pending', now() + interval '10 minutes', now()
  );

  -- A charge for neither a ticket nor a table is a charge for nothing.
  -- Written as 'expired' deliberately: an active row would collide with the
  -- one-active-checkout-per-guest index first and this assertion would pass
  -- without ever reaching the constraint it claims to test.
  failed := false;
  BEGIN
    INSERT INTO "party_checkouts" (
      "id", "party_id", "party_guest_id", "user_id", "idempotency_key",
      "ticket_tier_name", "table_id", "amount_cents", "table_amount_cents",
      "currency", "status", "reservation_expires_at", "updated_at"
    ) VALUES (
      'fixture-checkout-nothing', p_id, g_id, u_id, 'fixture-checkout-nothing-idem',
      NULL, NULL, 5000, 0,
      'usd', 'expired', now() + interval '10 minutes', now()
    );
  EXCEPTION WHEN check_violation THEN failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a checkout bought neither a ticket nor a table';
  END IF;

  -- The table's share can never exceed the charge it is a share of.
  failed := false;
  BEGIN
    UPDATE "party_checkouts" SET "table_amount_cents" = 9001 WHERE "id" = c_id;
  EXCEPTION WHEN check_violation THEN failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'the table share was allowed to exceed the whole charge';
  END IF;

  -- Deleting a table that a checkout points at would leave a guest paying for
  -- something that no longer exists. The API refuses this first; RESTRICT is
  -- the half that cannot be forgotten.
  failed := false;
  BEGIN
    DELETE FROM "party_tables" WHERE "id" = t_id;
  EXCEPTION WHEN foreign_key_violation THEN failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a table was deleted out from under a checkout that referenced it';
  END IF;

  -- Deleting the Party still takes its tables and checkouts with it: the
  -- restriction protects a guest from the host, not the Party from itself.
  DELETE FROM "parties" WHERE "id" = p_id;
  IF EXISTS (SELECT 1 FROM "party_tables" WHERE "id" = t_id) THEN
    RAISE EXCEPTION 'deleting the Party left its tables behind';
  END IF;
  IF EXISTS (SELECT 1 FROM "party_checkouts" WHERE "id" = c_id) THEN
    RAISE EXCEPTION 'deleting the Party left its checkouts behind';
  END IF;

  DELETE FROM "users" WHERE "id" = u_id;
  RAISE NOTICE 'party table checkout invariants hold';
END $$;
