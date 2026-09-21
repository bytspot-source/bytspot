-- Hostile shapes, not sample data. Nothing here is representative of
-- production; every row is a shape that broke a migration or came one cast
-- away from it. A backfill that survives this file has been executed against
-- the domain rather than against an empty database.
--
-- Add a row whenever a defect teaches us a new shape. Do not tidy rows away
-- because they look unrealistic — the unrealistic ones are the point.
--
-- Seeded after the migrations preceding the change under test and before the
-- change itself, so a backfill sees rows the way production will.
--
-- users.vehicles was an unvalidated JSONB array. 20260824 copied those
-- objects into the vehicles table; 20260920 dropped the column. This file
-- still has to seed the JSONB when the column is present (the vehicle
-- backfill under test) and still has to insert the same users when it is
-- not (every later migration). A single INSERT that names the column fails
-- the second case, which is how the first change after the drop went red.

INSERT INTO users (id, email, password, name, created_at, updated_at) VALUES
  ('hostile-1', 'hostile-1@example.invalid', 'x', 'Collision A', now(), now()),
  ('hostile-2', 'hostile-2@example.invalid', 'x', 'Collision B', now(), now()),
  ('hostile-3', 'hostile-3@example.invalid', 'x', 'Bad Years', now(), now()),
  ('hostile-4', 'hostile-4@example.invalid', 'x', 'Non Objects', now(), now()),
  ('hostile-5', 'hostile-5@example.invalid', 'x', 'Not An Array', now(), now()),
  ('hostile-6', 'hostile-6@example.invalid', 'x', 'Empty Array', now(), now()),
  ('hostile-7', 'hostile-7@example.invalid', 'x', 'Null Column', now(), now()),
  ('hostile-8', 'hostile-8@example.invalid', 'x', 'Empty Id', now(), now());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'vehicles'
  ) THEN
    RETURN;
  END IF;

  -- Two users minting ids from `v_${Date.now()}` collided with each other.
  -- The second and third rows here share an id with the first.
  UPDATE users SET vehicles =
    '[{"id":"v_1700000000000","type":"car","make":"Honda","model":"Civic","year":2019,"color":"blue","licensePlate":"AAA111"},
      {"id":"v_1700000000000","type":"car","make":"Toyota","model":"Camry","year":"2020","color":"red","licensePlate":"BBB222"}]'::jsonb
    WHERE id = 'hostile-1';

  -- Collides with hostile-1 across users, not within one. The new primary key
  -- is global, so this vehicle is re-keyed despite being unambiguous to its
  -- owner. It must still arrive.
  UPDATE users SET vehicles =
    '[{"id":"v_1700000000000","type":"car","make":"Mazda","model":"3","year":2021,"color":"white","licensePlate":"DDD444"}]'::jsonb
    WHERE id = 'hostile-2';

  -- year as a string that casts, a string that does not, and a numeric value
  -- too wide for int4. The last one aborted the deploy: it matched a digits-
  -- only guard and was rejected by the column.
  UPDATE users SET vehicles =
    '[{"id":"v_year_ok","make":"Ford","year":"2018"},
      {"id":"v_year_text","make":"Ford","year":"not-a-year"},
      {"id":"v_year_wide","make":"Ford","year":99999999999999}]'::jsonb
    WHERE id = 'hostile-3';

  -- Elements that are not objects. Each reads as an object with every field
  -- absent, which is how a row with a synthesised id and no make, model or
  -- plate got invented — a vehicle nobody saved, indistinguishable from one
  -- they did. These must produce no rows at all.
  UPDATE users SET vehicles = '["a string", null, 123, true]'::jsonb
    WHERE id = 'hostile-4';

  -- The column itself is not always an array.
  UPDATE users SET vehicles = '{"id":"an object, not a list"}'::jsonb
    WHERE id = 'hostile-5';
  UPDATE users SET vehicles = '[]'::jsonb WHERE id = 'hostile-6';
  UPDATE users SET vehicles = NULL WHERE id = 'hostile-7';

  -- An id that is present but empty, which a COALESCE on NULL alone misses.
  UPDATE users SET vehicles =
    '[{"id":"","make":"Subaru","model":"Outback","year":2016}]'::jsonb
    WHERE id = 'hostile-8';
END $$;
