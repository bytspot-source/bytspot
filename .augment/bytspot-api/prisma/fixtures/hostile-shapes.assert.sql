-- What the backfill must have done to prisma/fixtures/hostile-shapes.sql.
--
-- Exit code is not enough. The defect that reached production exited 0: it
-- invented a vehicle out of a JSON string. Only a row assertion catches that
-- class, so this file asserts on the result, not on the run.
--
-- Grows alongside the fixture. A migration that does not touch these tables
-- leaves these assertions trivially true, which is the correct outcome.

DO $$
DECLARE
  actual integer;
BEGIN
  -- Nothing real is dropped. Seven vehicle objects across the fixture, three
  -- of which share one id; a collision is re-keyed, never discarded.
  SELECT count(*) INTO actual FROM vehicles WHERE user_id LIKE 'hostile-%';
  IF actual <> 7 THEN
    RAISE EXCEPTION 'backfill produced % vehicles, expected 7', actual;
  END IF;

  -- Nothing is invented. Non-object elements are not vehicles, and a column
  -- that is not an array holds none.
  SELECT count(*) INTO actual FROM vehicles WHERE user_id IN ('hostile-4', 'hostile-5', 'hostile-6', 'hostile-7');
  IF actual <> 0 THEN
    RAISE EXCEPTION 'backfill invented % vehicles from non-objects', actual;
  END IF;

  -- Both sides of a collision survive, under distinct ids.
  SELECT count(DISTINCT id) INTO actual FROM vehicles WHERE user_id IN ('hostile-1', 'hostile-2');
  IF actual <> 3 THEN
    RAISE EXCEPTION 'collision resolution left % distinct ids, expected 3', actual;
  END IF;

  -- A year that cannot be trusted becomes 0 rather than aborting the deploy.
  SELECT year INTO actual FROM vehicles WHERE user_id = 'hostile-3' AND make = 'Ford' AND year > 0;
  IF actual <> 2018 THEN
    RAISE EXCEPTION 'castable year became %, expected 2018', actual;
  END IF;

  SELECT count(*) INTO actual FROM vehicles WHERE user_id = 'hostile-3' AND year = 0;
  IF actual <> 2 THEN
    RAISE EXCEPTION '% unusable years survived as 0, expected 2', actual;
  END IF;

  -- An empty id is replaced, not carried through as an empty primary key.
  SELECT count(*) INTO actual FROM vehicles WHERE user_id = 'hostile-8' AND id <> '';
  IF actual <> 1 THEN
    RAISE EXCEPTION 'empty legacy id was not replaced';
  END IF;
END $$;
