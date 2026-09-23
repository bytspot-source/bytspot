-- Position is what turns a bag of items into a sequence, so this fixture
-- asserts the closed side holds: the column is nullable and has no default,
-- the backfill reproduced the attach order per plan rather than globally,
-- plans do not share a numbering, duplicate positions remain storable, an
-- unpositioned row sorts last rather than first, and the read index exists.
DO $$
DECLARE
  u_id TEXT := 'fixture-position-user';
  plan_a TEXT := 'fixture-position-plan-a';
  plan_b TEXT := 'fixture-position-plan-b';
  got INT;
  ordered TEXT;
BEGIN
  IF to_regclass('public.plan_items') IS NULL THEN
    RAISE EXCEPTION 'plan_items table missing';
  END IF;

  -- Nullable, so a row inserted by an instance still on the previous deploy
  -- records that it has no stated position rather than silently claiming
  -- slot 0 and reordering someone's evening.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plan_items' AND column_name = 'position' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'plan_items.position missing or NOT NULL';
  END IF;

  -- And no default, which is what makes that row distinguishable at all.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plan_items' AND column_name = 'position'
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'plan_items.position has a default, so an old writer cannot be told apart';
  END IF;

  -- The backfill left no existing row unpositioned.
  SELECT count(*) INTO got FROM plan_items WHERE "position" IS NULL;
  IF got <> 0 THEN
    RAISE EXCEPTION 'backfill left % plan_items without a position', got;
  END IF;

  -- The read path is "one plan's items, in order".
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'plan_items' AND indexname = 'plan_items_plan_position_idx'
  ) THEN
    RAISE EXCEPTION 'plan_items_plan_position_idx missing';
  END IF;

  INSERT INTO users (id, email, password, created_at, updated_at)
  VALUES (u_id, 'fixture-position@bytspot.test', 'fixture-placeholder-not-a-credential', now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO plans (id, creator_user_id, idempotency_key, title, intent, join_token, created_at, updated_at)
  VALUES
    (plan_a, u_id, 'fixture-position-key-a', 'A', 'A', 'fixture-position-token-a', now(), now()),
    (plan_b, u_id, 'fixture-position-key-b', 'B', 'B', 'fixture-position-token-b', now(), now());

  -- Two plans, each numbering from zero. Numbering is per plan; a global
  -- sequence would make the second plan start wherever the first stopped.
  INSERT INTO plan_items (id, plan_id, need_kind, title, "position", created_at, updated_at)
  VALUES
    ('fixture-position-a0', plan_a, 'coffee', 'A first', 0, now(), now()),
    ('fixture-position-a1', plan_a, 'dining', 'A second', 1, now(), now()),
    ('fixture-position-b0', plan_b, 'dining', 'B first', 0, now(), now());

  SELECT string_agg(title, ',' ORDER BY "position", created_at, id) INTO ordered
  FROM plan_items WHERE plan_id = plan_a;
  IF ordered <> 'A first,A second' THEN
    RAISE EXCEPTION 'plan A reads back as %, not its stated order', ordered;
  END IF;

  SELECT "position" INTO got FROM plan_items WHERE id = 'fixture-position-b0';
  IF got <> 0 THEN
    RAISE EXCEPTION 'a second plan started at % instead of 0', got;
  END IF;

  -- A racing attach may briefly duplicate a position. Refusing that write
  -- would fail an attach because someone else added at the same moment, so it
  -- must remain storable and the tie is broken on read instead.
  INSERT INTO plan_items (id, plan_id, need_kind, title, "position", created_at, updated_at)
  VALUES ('fixture-position-a1-dup', plan_a, 'nightlife', 'A second again', 1, now(), now());

  SELECT count(*) INTO got FROM plan_items WHERE plan_id = plan_a AND "position" = 1;
  IF got <> 2 THEN
    RAISE EXCEPTION 'expected a duplicate position to be storable, found % rows', got;
  END IF;

  -- An insert that states no position still lands, exactly as one from an
  -- instance running the previous deploy would.
  INSERT INTO plan_items (id, plan_id, need_kind, title, created_at, updated_at)
  VALUES ('fixture-position-default', plan_b, 'coffee', 'B default', now(), now());
  SELECT count(*) INTO got
  FROM plan_items WHERE id = 'fixture-position-default' AND "position" IS NULL;
  IF got <> 1 THEN
    RAISE EXCEPTION 'an insert stating no position did not record it as unstated';
  END IF;

  -- And it is lived last, not first. This is the whole reason the column is
  -- nullable: with a default of 0 this row would have displaced B first.
  SELECT string_agg(title, ',' ORDER BY "position" NULLS LAST, created_at, id) INTO ordered
  FROM plan_items WHERE plan_id = plan_b;
  IF ordered <> 'B first,B default' THEN
    RAISE EXCEPTION 'an unpositioned item read back as %, not appended', ordered;
  END IF;

  DELETE FROM plan_items WHERE plan_id IN (plan_a, plan_b);
  DELETE FROM plans WHERE id IN (plan_a, plan_b);
  DELETE FROM users WHERE id = u_id;
END $$;
