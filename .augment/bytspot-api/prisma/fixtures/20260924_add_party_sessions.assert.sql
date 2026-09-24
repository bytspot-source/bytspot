-- A session is bottles and a stretch of time, sold as one unit.
--
-- This fixture asserts the closed side of that: units cannot be oversold,
-- bottle terms admit exactly two shapes, a place is stated completely or not
-- at all, and — the point of the rewrite — nothing ties a session's hours or
-- address to the Party's, so an after-hours session at another venue stores
-- cleanly. It also asserts that admission no longer carries a session, and
-- that a checkout must buy something.
DO $$
DECLARE
  u_id TEXT := 'fixture-session-user';
  seller_id TEXT := 'fixture-session-seller';
  fx_party TEXT := 'fixture-session-party';
  guest_id TEXT := 'fixture-session-guest';
  s_id TEXT := 'fixture-session-1';
  after_id TEXT := 'fixture-session-after';
  got INT;
BEGIN
  IF to_regclass('public.party_sessions') IS NULL THEN
    RAISE EXCEPTION 'party_sessions table missing';
  END IF;
  IF to_regclass('public.party_session_claims') IS NULL THEN
    RAISE EXCEPTION 'party_session_claims table missing';
  END IF;

  -- Admission stopped carrying the session when buying bottles was found to
  -- rewrite the pass. The column must be gone, not merely unused.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'party_guests' AND column_name = 'table_id'
  ) THEN
    RAISE EXCEPTION 'party_guests still carries table_id; admission and bottles are separate sales';
  END IF;

  INSERT INTO "users" ("id", "email", "password", "created_at", "updated_at")
  VALUES (u_id, 'fixture-session@bytspot.test', 'fixture-not-a-real-hash', NOW(), NOW())
  ON CONFLICT ("id") DO NOTHING;

  INSERT INTO "vendor_sellers" ("id", "state", "business_mode", "created_at", "updated_at")
  VALUES (seller_id, 'DRAFT', 'standard', NOW(), NOW())
  ON CONFLICT ("id") DO NOTHING;

  INSERT INTO "parties" (
    "id", "host_user_id", "idempotency_key", "template_id", "title", "tagline", "starts_at", "ends_at",
    "venue_name", "location_disclosure", "capacity", "access_mode",
    "required_membership_tier", "status", "itinerary", "ticket_tiers", "cohosts", "template_config", "created_at", "updated_at"
  )
  VALUES (
    fx_party, u_id, 'fixture-session-party-key', 'listening-party', 'Fixture Night', 'One moment.',
    NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 4 hours',
    'Fixture Room', 'public', 40, 'free-rsvp', 'green', 'published', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, NOW(), NOW()
  )
  ON CONFLICT ("id") DO NOTHING;

  -- ── A table during the night ──────────────────────────────────────────
  INSERT INTO "party_sessions" (
    "id", "party_id", "seller_id", "name", "kind", "starts_at", "ends_at",
    "bottle_count", "bottle_terms", "price_cents", "quantity", "committed",
    "position", "created_at", "updated_at"
  )
  VALUES (
    s_id, fx_party, seller_id, 'Front Table', 'table',
    NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 4 hours',
    4, 'included', 90000, 1, 0, 0, NOW(), NOW()
  );

  -- ── An after-hours session, later and elsewhere ───────────────────────
  -- The rule this replaces refused exactly this row, so storing it is the
  -- assertion. It ends four hours after the Party does, at another address.
  INSERT INTO "party_sessions" (
    "id", "party_id", "seller_id", "name", "kind", "starts_at", "ends_at",
    "venue_name", "lat", "lng",
    "bottle_count", "bottle_terms", "price_cents", "quantity", "committed",
    "position", "created_at", "updated_at"
  )
  VALUES (
    after_id, fx_party, seller_id, 'After Hours', 'after-hours',
    NOW() + INTERVAL '1 day 4 hours', NOW() + INTERVAL '1 day 8 hours',
    'The Annex', 33.77, -84.36,
    2, 'minimum', 20000, 1, 0, 1, NOW(), NOW()
  );

  -- Bottle counts are not weighed against the room: these two sessions sell
  -- six bottles between them and the Party holds forty people. Unrelated
  -- quantities, and nothing here compares them.
  SELECT COUNT(*) INTO got FROM "party_sessions" WHERE "party_id" = fx_party;
  IF got <> 2 THEN
    RAISE EXCEPTION 'expected both sessions stored, got %', got;
  END IF;

  -- ── Units cannot be oversold ──────────────────────────────────────────
  BEGIN
    UPDATE "party_sessions" SET "committed" = 2 WHERE "id" = s_id;
    RAISE EXCEPTION 'committed above quantity must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE "party_sessions" SET "committed" = -1 WHERE "id" = s_id;
    RAISE EXCEPTION 'negative committed must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── Two bottle shapes and no third ────────────────────────────────────
  BEGIN
    UPDATE "party_sessions" SET "bottle_terms" = 'on-request' WHERE "id" = s_id;
    RAISE EXCEPTION 'an unknown bottle term must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── A place is complete or absent ─────────────────────────────────────
  BEGIN
    UPDATE "party_sessions" SET "lat" = 33.77, "lng" = NULL WHERE "id" = after_id;
    RAISE EXCEPTION 'half an address must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── A session ordered against itself, and nothing else ────────────────
  BEGIN
    UPDATE "party_sessions" SET "ends_at" = "starts_at" - INTERVAL '1 hour' WHERE "id" = s_id;
    RAISE EXCEPTION 'a session ending before it starts must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── A claim is the guest's hold, off the admission row ────────────────
  INSERT INTO "party_guests" ("id", "party_id", "user_id", "status", "access_granted", "created_at", "updated_at")
  VALUES (guest_id, fx_party, u_id, 'ticketed', TRUE, NOW(), NOW())
  ON CONFLICT ("id") DO NOTHING;

  INSERT INTO "party_session_claims" ("id", "session_id", "party_id", "user_id", "state", "created_at", "updated_at")
  VALUES ('fixture-session-claim', s_id, fx_party, u_id, 'held', NOW(), NOW());

  BEGIN
    UPDATE "party_session_claims" SET "state" = 'maybe' WHERE "id" = 'fixture-session-claim';
    RAISE EXCEPTION 'an unknown claim state must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The guest still holds the pass they arrived with; the claim sits beside
  -- it rather than on it.
  SELECT COUNT(*) INTO got FROM "party_guests"
  WHERE "id" = guest_id AND "access_granted" = TRUE;
  IF got <> 1 THEN
    RAISE EXCEPTION 'admission must be untouched by a session claim';
  END IF;

  -- ── A checkout buys something ─────────────────────────────────────────
  BEGIN
    INSERT INTO "party_checkouts" (
      "id", "party_id", "party_guest_id", "user_id", "idempotency_key",
      "amount_cents", "currency", "status", "reservation_expires_at",
      "created_at", "updated_at"
    )
    VALUES (
      'fixture-session-empty-checkout', fx_party, guest_id, u_id, 'fixture-empty',
      0, 'usd', 'creating', NOW() + INTERVAL '10 minutes', NOW(), NOW()
    );
    RAISE EXCEPTION 'a checkout buying neither a ticket nor a session must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Money for a session requires a session to have bought.
  BEGIN
    INSERT INTO "party_checkouts" (
      "id", "party_id", "party_guest_id", "user_id", "idempotency_key",
      "ticket_tier_name", "amount_cents", "session_amount_cents", "currency",
      "status", "reservation_expires_at", "created_at", "updated_at"
    )
    VALUES (
      'fixture-session-orphan-money', fx_party, guest_id, u_id, 'fixture-orphan',
      'First Drop', 2500, 9000, 'usd', 'creating', NOW() + INTERVAL '10 minutes', NOW(), NOW()
    );
    RAISE EXCEPTION 'session money without a session must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A settled session must survive its checkout being tidied away, or a
  -- guest holding bottles would quietly stop holding them.
  INSERT INTO "party_checkouts" (
    "id", "party_id", "party_guest_id", "user_id", "idempotency_key",
    "session_id", "amount_cents", "session_amount_cents", "currency",
    "status", "reservation_expires_at", "created_at", "updated_at"
  )
  VALUES (
    'fixture-session-checkout', fx_party, guest_id, u_id, 'fixture-session',
    s_id, 90000, 90000, 'usd', 'completed', NOW() + INTERVAL '10 minutes', NOW(), NOW()
  );

  BEGIN
    DELETE FROM "party_sessions" WHERE "id" = s_id;
    RAISE EXCEPTION 'a session under a checkout must not be deletable';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- ── Cleanup ───────────────────────────────────────────────────────────
  DELETE FROM "party_checkouts" WHERE "party_id" = fx_party;
  DELETE FROM "party_session_claims" WHERE "party_id" = fx_party;
  DELETE FROM "party_sessions" WHERE "party_id" = fx_party;
  DELETE FROM "party_guests" WHERE "party_id" = fx_party;
  DELETE FROM "parties" WHERE "id" = fx_party;
  DELETE FROM "vendor_sellers" WHERE "id" = seller_id;
  DELETE FROM "users" WHERE "id" = u_id;

  RAISE NOTICE 'party session fixture passed';
END $$;
