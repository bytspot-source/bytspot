-- Saved vehicles move out of the users.vehicles JSONB array into rows.
--
-- The array had two defects a row cannot have. Every mutation was a
-- read-modify-write of the whole array, so two concurrent adds lost one
-- vehicle. And ids were minted as `v_${Date.now()}`, so two vehicles created
-- in the same millisecond shared an id: `update` edited whichever the scan
-- found first, and `remove` deleted both.
--
-- users.vehicles is left in place and stops being read this deploy. It is
-- dropped in a follow-up, once this table has been serving.

CREATE TABLE "vehicles" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "make" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "color" TEXT NOT NULL,
  "license_plate" TEXT NOT NULL,
  "photo" TEXT,
  "vin" TEXT,
  "transmission_type" TEXT NOT NULL,
  "trunk_category" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vehicles_user_id_idx" ON "vehicles"("user_id");

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill. Legacy ids are preserved so an iOS client holding one from a
-- previous `list` can still update or remove that vehicle without re-listing.
--
-- Legacy ids were only ever unique by luck, and the primary key here is
-- global, so a collision has to be resolved rather than tolerated: ON CONFLICT
-- DO NOTHING would silently drop a real vehicle, which is the same data loss
-- this migration exists to stop. Colliding rows keep the first occurrence's id
-- and the rest are re-keyed. Those are precisely the vehicles that were
-- already unaddressable, so a new id loses nothing that worked.
--
-- The re-keyed form embeds the owner and the array position, which are unique
-- per source row, so the replacement cannot collide with another re-keyed row.
-- A bare `|| '_' || rank` suffix could have collided with a real legacy id.
INSERT INTO "vehicles" (
  "id", "user_id", "type", "make", "model", "year", "color",
  "license_plate", "photo", "vin", "transmission_type", "trunk_category"
)
SELECT
  CASE
    WHEN collision_rank = 1 THEN legacy_id
    ELSE legacy_id || '_dup_' || user_id || '_' || v_index
  END,
  user_id, type, make, model, year, color,
  license_plate, photo, vin, transmission_type, trunk_category
FROM (
  SELECT
    COALESCE(NULLIF(v->>'id', ''), 'v_' || u.id || '_' || v_index) AS legacy_id,
    u.id AS user_id,
    COALESCE(NULLIF(v->>'type', ''), 'sedan') AS type,
    COALESCE(v->>'make', '') AS make,
    COALESCE(v->>'model', '') AS model,
    -- The JSON array was never schema-checked on the way in, so a non-numeric
    -- year is possible and an unguarded cast would abort the whole migration
    -- over one bad row. Digits alone are not enough: any value wider than
    -- four digits overflows int4 and aborts the same way, which is a cast the
    -- regex admits and the column rejects.
    COALESCE(CASE WHEN v->>'year' ~ '^[0-9]{1,4}$' THEN (v->>'year')::int END, 0) AS year,
    COALESCE(v->>'color', '') AS color,
    COALESCE(v->>'licensePlate', '') AS license_plate,
    NULLIF(v->>'photo', '') AS photo,
    NULLIF(v->>'vin', '') AS vin,
    COALESCE(NULLIF(v->>'transmissionType', ''), 'automatic') AS transmission_type,
    COALESCE(NULLIF(v->>'trunkCategory', ''), 'full') AS trunk_category,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(v->>'id', ''), 'v_' || u.id || '_' || v_index)
      ORDER BY u.id, v_index
    ) AS collision_rank,
    v_index
  FROM "users" u
  -- CASE, not WHERE. jsonb_typeof in WHERE is not a short-circuit: Postgres
  -- still evaluates the LATERAL, so a JSON object, string or number in the
  -- column — every shape except an array — aborts the whole transaction with
  -- "cannot extract elements from a scalar" / "cannot extract elements from
  -- an object". An aborted pre-deploy is what has been holding every merge
  -- since 17:26 UTC. CASE never calls jsonb_array_elements on a non-array.
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(u."vehicles") = 'array' THEN u."vehicles" ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS t(v, v_index)
  -- Elements are only vehicles if they are objects. A scalar or null element
  -- reads as an object with every field absent, which would materialise a row
  -- with a synthesised id and no make, model or plate: a vehicle that never
  -- existed, indistinguishable from one the owner saved.
  WHERE jsonb_typeof(v) = 'object'
) legacy;
