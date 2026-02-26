-- PostGIS + pgvector extensions (defensive: skips gracefully if not available)
-- Render free-tier Postgres may not support these extensions.
-- When you upgrade to a paid plan, re-run this migration or apply manually.

DO $$
BEGIN
  -- Try to enable PostGIS
  BEGIN
    CREATE EXTENSION IF NOT EXISTS postgis;
    ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "location" geometry(Point, 4326);
    UPDATE "venues" SET "location" = ST_SetSRID(ST_MakePoint("lng", "lat"), 4326) WHERE "location" IS NULL;
    CREATE INDEX IF NOT EXISTS "venues_location_idx" ON "venues" USING GIST ("location");
    RAISE NOTICE 'PostGIS enabled successfully';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PostGIS not available: %, skipping geo columns', SQLERRM;
  END;

  -- Try to enable pgvector
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "embedding" vector(384);
    CREATE INDEX IF NOT EXISTS "venues_embedding_idx" ON "venues" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 10);
    RAISE NOTICE 'pgvector enabled successfully';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available: %, skipping embedding columns', SQLERRM;
  END;
END $$;
