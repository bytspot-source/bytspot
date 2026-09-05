-- One nullable, unique column on venues so a host's searched arrival place
-- maps to at most one Venue. Nothing backfills; hostile-shapes.sql already
-- covers survival across every migration in the run.
DO $$
BEGIN
  -- The column exists and is nullable: seeded and legacy venues carry no
  -- Google place id and must not be forced to invent one.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'venues' AND column_name = 'google_place_id'
  ) THEN
    RAISE EXCEPTION 'venues.google_place_id column missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'venues' AND column_name = 'google_place_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'venues.google_place_id must be nullable';
  END IF;

  -- Uniqueness is the dedupe guarantee: binding the same place twice reuses
  -- one venue instead of creating a second.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'venues_google_place_id_key') THEN
    RAISE EXCEPTION 'venues.google_place_id must be unique';
  END IF;

  -- Every venue that survived the run kept a NULL place id; the migration
  -- adds a column, it does not fabricate identities for existing rows.
  IF EXISTS (SELECT 1 FROM venues WHERE google_place_id IS NOT NULL) THEN
    RAISE EXCEPTION 'no existing venue should have a google_place_id after this migration';
  END IF;
END $$;
