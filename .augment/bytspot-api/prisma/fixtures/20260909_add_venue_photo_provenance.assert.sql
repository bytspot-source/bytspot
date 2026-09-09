-- Venue photo provenance is a trust gate, so this fixture asserts the closed
-- side holds: existing rows land on 'borrowed' without a backfill, the domain
-- is unstorable outside its three values, owned provenance cannot exist without
-- a photograph, and pin eligibility is nowhere a column.
DO $$
DECLARE
  needed TEXT;
  borrowed_count INT;
  total_count INT;
BEGIN
  IF to_regclass('public.venues') IS NULL THEN
    RAISE EXCEPTION 'venues table missing';
  END IF;

  -- Both columns must exist, and provenance must be NOT NULL with the
  -- fail-closed default. A nullable provenance is an open gate.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'venues' AND column_name = 'photo_provenance'
      AND is_nullable = 'NO' AND column_default LIKE '%borrowed%'
  ) THEN
    RAISE EXCEPTION 'venues.photo_provenance must be NOT NULL DEFAULT ''borrowed''';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'venues' AND column_name = 'photo_attribution'
  ) THEN
    RAISE EXCEPTION 'venues.photo_attribution missing';
  END IF;

  FOR needed IN
    SELECT unnest(ARRAY[
      'venues_photo_provenance_check',
      'venues_owned_photo_requires_image_check'
    ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = needed AND contype = 'c'
    ) THEN
      RAISE EXCEPTION 'CHECK constraint % missing', needed;
    END IF;
  END LOOP;

  -- Pin eligibility is derived, never stored. A column here would let a row
  -- contradict its own provenance.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'venues'
      AND column_name IN ('earns_map_pin', 'map_presentation', 'is_pin', 'pin_eligible')
  ) THEN
    RAISE EXCEPTION 'pin eligibility must be derived, not stored on venues';
  END IF;

  -- Rows that existed before this migration must all have landed closed.
  SELECT count(*) INTO total_count FROM venues;
  SELECT count(*) INTO borrowed_count FROM venues WHERE photo_provenance = 'borrowed';
  IF total_count <> borrowed_count THEN
    RAISE EXCEPTION 'migration must not grant provenance: % of % venues are not borrowed',
      total_count - borrowed_count, total_count;
  END IF;
END $$;

-- An unrecognised provenance must be rejected by the database, not the router.
DO $$
DECLARE
  v_id TEXT;
BEGIN
  SELECT id INTO v_id FROM venues LIMIT 1;
  IF v_id IS NULL THEN
    RAISE NOTICE 'no venues seeded; domain enforcement asserted structurally above';
    RETURN;
  END IF;

  BEGIN
    UPDATE venues SET photo_provenance = 'google_places' WHERE id = v_id;
    RAISE EXCEPTION 'venues.photo_provenance accepted a value outside its domain';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- Owned provenance without a photograph must be impossible.
  BEGIN
    UPDATE venues SET photo_provenance = 'bytspot_owned', image_url = NULL WHERE id = v_id;
    RAISE EXCEPTION 'venues accepted owned provenance with no photograph';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END $$;
