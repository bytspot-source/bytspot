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

-- users.vehicles was an unvalidated JSONB array. Every shape below reached it.
INSERT INTO users (id, email, password, name, created_at, updated_at, vehicles) VALUES
  -- Two users minting ids from `v_${Date.now()}` collided with each other.
  -- The second and third rows here share an id with the first.
  ('hostile-1', 'hostile-1@example.invalid', 'x', 'Collision A', now(), now(),
   '[{"id":"v_1700000000000","type":"car","make":"Honda","model":"Civic","year":2019,"color":"blue","licensePlate":"AAA111"},
     {"id":"v_1700000000000","type":"car","make":"Toyota","model":"Camry","year":"2020","color":"red","licensePlate":"BBB222"}]'::jsonb),

  -- Collides with hostile-1 across users, not within one. The new primary key
  -- is global, so this vehicle is re-keyed despite being unambiguous to its
  -- owner. It must still arrive.
  ('hostile-2', 'hostile-2@example.invalid', 'x', 'Collision B', now(), now(),
   '[{"id":"v_1700000000000","type":"car","make":"Mazda","model":"3","year":2021,"color":"white","licensePlate":"DDD444"}]'::jsonb),

  -- year as a string that casts, a string that does not, and a numeric value
  -- too wide for int4. The last one aborted the deploy: it matched a digits-
  -- only guard and was rejected by the column.
  ('hostile-3', 'hostile-3@example.invalid', 'x', 'Bad Years', now(), now(),
   '[{"id":"v_year_ok","make":"Ford","year":"2018"},
     {"id":"v_year_text","make":"Ford","year":"not-a-year"},
     {"id":"v_year_wide","make":"Ford","year":99999999999999}]'::jsonb),

  -- Elements that are not objects. Each reads as an object with every field
  -- absent, which is how a row with a synthesised id and no make, model or
  -- plate got invented — a vehicle nobody saved, indistinguishable from one
  -- they did. These must produce no rows at all.
  ('hostile-4', 'hostile-4@example.invalid', 'x', 'Non Objects', now(), now(),
   '["a string", null, 123, true]'::jsonb),

  -- The column itself is not always an array.
  ('hostile-5', 'hostile-5@example.invalid', 'x', 'Not An Array', now(), now(),
   '{"id":"an object, not a list"}'::jsonb),
  ('hostile-6', 'hostile-6@example.invalid', 'x', 'Empty Array', now(), now(), '[]'::jsonb),
  ('hostile-7', 'hostile-7@example.invalid', 'x', 'Null Column', now(), now(), NULL),

  -- An id that is present but empty, which a COALESCE on NULL alone misses.
  ('hostile-8', 'hostile-8@example.invalid', 'x', 'Empty Id', now(), now(),
   '[{"id":"","make":"Subaru","model":"Outback","year":2016}]'::jsonb);
