-- Disposable migration-fixture database ONLY. These assertions always roll back.
BEGIN;
DO $$
DECLARE u TEXT := 'fixture-music-host'; p TEXT := 'fixture-music-party';
BEGIN
  IF EXISTS (SELECT 1 FROM parties WHERE music_kind IS NOT NULL OR cardinality(music_genres) > 0 OR music_set_starts_at IS NOT NULL)
  THEN RAISE EXCEPTION 'migration invented music on an existing Party'; END IF;
  INSERT INTO users (id, email, password, updated_at)
    VALUES (u, 'fixture-music@bytspot.test', 'fixture-not-a-real-hash', NOW());
  INSERT INTO parties (id, host_user_id, idempotency_key, template_id, title, tagline, starts_at,
    venue_name, capacity, access_mode, required_membership_tier, status, itinerary, ticket_tiers, cohosts, template_config, updated_at)
    VALUES (p, u, p, 'listening-party', 'Fixture', '', NOW(), 'Fixture', 20, 'free-rsvp', 'green',
      'published', '[]', '[]', '[]', '{}', NOW());
  IF (SELECT music_kind FROM parties WHERE id = p) IS NOT NULL THEN RAISE EXCEPTION 'new Party declares music by default'; END IF;
  UPDATE parties SET music_kind = 'both', music_genres = ARRAY['afrobeats', 'live-band'], music_set_starts_at = NOW() WHERE id = p;
  BEGIN
    UPDATE parties SET music_kind = 'karaoke' WHERE id = p;
    RAISE EXCEPTION 'unknown music kind accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE parties SET music_genres = ARRAY['jazz', 'house', 'latin'] WHERE id = p;
    RAISE EXCEPTION 'three genres accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE parties SET music_genres = ARRAY['polka'] WHERE id = p;
    RAISE EXCEPTION 'unknown genre accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE parties SET music_kind = NULL WHERE id = p;
    RAISE EXCEPTION 'genres without music accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE parties SET music_genres = ARRAY[]::TEXT[] WHERE id = p;
    RAISE EXCEPTION 'music without a genre accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
