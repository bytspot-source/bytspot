-- Run only on a disposable migrated test database. Always rolls back.
BEGIN;
DO $$
DECLARE
  u TEXT := 'fixture-performer-20260924';
  p TEXT := 'fixture-lineup-20260924';
BEGIN
  INSERT INTO users (id, email, password, updated_at)
    VALUES (u, 'fixture-lineup@bytspot.test', 'fixture-not-a-real-hash', NOW());
  INSERT INTO parties (id, host_user_id, idempotency_key, template_id, title, tagline, starts_at,
    venue_name, capacity, access_mode, required_membership_tier, status, itinerary, ticket_tiers, cohosts, template_config, updated_at)
    VALUES (p, u, p, 'listening-party', 'Fixture', '', NOW(), 'Fixture', 20, 'free-rsvp', 'green',
      'published', '[]', '[]', '[]', '{}', NOW());
  -- Unknown account IDs can receive opaque proposals, but cannot confirm.
  INSERT INTO party_performers (id, party_id, invited_user_id, display_name, role, updated_at)
    VALUES ('fixture-credit', p, u, 'Fixture DJ', 'dj', NOW());
  BEGIN
    UPDATE party_performers SET status = 'accepted' WHERE id = 'fixture-credit';
    RAISE EXCEPTION 'acceptance without account and consent timestamp was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE party_performers SET confirmed_user_id = 'someone-else' WHERE id = 'fixture-credit';
    RAISE EXCEPTION 'account substitution was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO party_performers (id, party_id, invited_user_id, display_name, role, updated_at)
      VALUES ('fixture-duplicate', p, u, 'Duplicate', 'dj', NOW());
    RAISE EXCEPTION 'duplicate active credit was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE party_performers SET status = 'accepted', confirmed_user_id = u, confirmed_at = NOW(),
    tip_handles = '[{"provider":"venmo","handle":"fixture"}]', version = 1 WHERE id = 'fixture-credit';
  BEGIN
    UPDATE party_performers SET status = 'removed' WHERE id = 'fixture-credit';
    RAISE EXCEPTION 'withdrawal retaining tips was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE party_performers SET status = 'removed', tip_handles = '[]', confirmed_at = NULL WHERE id = 'fixture-credit';
  DELETE FROM parties WHERE id = p;
  IF EXISTS (SELECT 1 FROM party_performers WHERE id = 'fixture-credit') THEN
    RAISE EXCEPTION 'party cascade failed';
  END IF;
  RAISE NOTICE 'party performer fixture passed';
END $$;
ROLLBACK;
