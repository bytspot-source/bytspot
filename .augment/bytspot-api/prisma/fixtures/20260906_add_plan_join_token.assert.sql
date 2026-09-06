-- Adding the Plan join token is additive: one new NOT NULL, uniquely-indexed
-- column, backfilled so no existing Plan is left without a token. hostile-shapes
-- seeds no Plans, so this asserts structure and the backfill invariant.
DO $$
BEGIN
  -- The column exists and is NOT NULL — every Plan carries a token.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plans' AND column_name = 'join_token' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'plans.join_token must exist and be NOT NULL';
  END IF;

  -- It is uniquely indexed, so a token names at most one Plan.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'plans_join_token_key' AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'plans.join_token must have a UNIQUE index';
  END IF;

  -- The backfill left no Plan tokenless.
  IF EXISTS (SELECT 1 FROM "plans" WHERE "join_token" IS NULL) THEN
    RAISE EXCEPTION 'every Plan must have a join_token after backfill';
  END IF;
END $$;
