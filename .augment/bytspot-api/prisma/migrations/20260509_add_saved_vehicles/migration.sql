-- Create relational saved vehicles while keeping the legacy users.vehicles JSON
-- column for backward compatibility during rollout.
CREATE TABLE IF NOT EXISTS "vehicles" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'sedan',
  "make" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "color" TEXT NOT NULL,
  "license_plate" TEXT NOT NULL,
  "photo" TEXT,
  "vin" TEXT,
  "transmission_type" TEXT NOT NULL DEFAULT 'automatic',
  "trunk_category" TEXT NOT NULL DEFAULT 'full',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vehicles_user_id_license_plate_key" ON "vehicles"("user_id", "license_plate");
CREATE INDEX IF NOT EXISTS "vehicles_user_id_created_at_idx" ON "vehicles"("user_id", "created_at" DESC);

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "vehicles" (
  "id", "user_id", "type", "make", "model", "year", "color", "license_plate",
  "photo", "vin", "transmission_type", "trunk_category", "created_at", "updated_at"
)
SELECT
  COALESCE(NULLIF(vehicle->>'id', ''), 'veh_' || md5(u."id" || ':' || legacy.ordinality::text)),
  u."id",
  COALESCE(NULLIF(vehicle->>'type', ''), 'sedan'),
  LEFT(COALESCE(NULLIF(vehicle->>'make', ''), 'Unknown'), 120),
  LEFT(COALESCE(NULLIF(vehicle->>'model', ''), 'Vehicle'), 120),
  CASE
    WHEN NULLIF(vehicle->>'year', '') ~ '^[0-9]+$' THEN (vehicle->>'year')::integer
    ELSE EXTRACT(YEAR FROM CURRENT_DATE)::integer
  END,
  LEFT(COALESCE(NULLIF(vehicle->>'color', ''), 'Unknown'), 80),
  LEFT(COALESCE(NULLIF(vehicle->>'licensePlate', ''), 'LEGACY' || legacy.ordinality::text), 32),
  NULLIF(vehicle->>'photo', ''),
  NULLIF(vehicle->>'vin', ''),
  COALESCE(NULLIF(vehicle->>'transmissionType', ''), 'automatic'),
  COALESCE(NULLIF(vehicle->>'trunkCategory', ''), 'full'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "users" u
CROSS JOIN LATERAL jsonb_array_elements(u."vehicles"::jsonb) WITH ORDINALITY AS legacy(vehicle, ordinality)
WHERE u."vehicles" IS NOT NULL
  AND jsonb_typeof(u."vehicles"::jsonb) = 'array'
ON CONFLICT DO NOTHING;