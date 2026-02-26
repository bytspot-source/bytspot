-- Enable PostGIS for geospatial queries (ST_DWithin, ST_Distance, etc.)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Enable pgvector for AI embedding similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Add geometry column for venue location (SRID 4326 = WGS84 lat/lng)
ALTER TABLE "venues" ADD COLUMN "location" geometry(Point, 4326);

-- Populate location from existing lat/lng columns
UPDATE "venues" SET "location" = ST_SetSRID(ST_MakePoint("lng", "lat"), 4326);

-- Spatial index for fast radius/bounding-box queries
CREATE INDEX "venues_location_idx" ON "venues" USING GIST ("location");

-- Add vector column for AI embeddings (384 dimensions = sentence-transformers default)
ALTER TABLE "venues" ADD COLUMN "embedding" vector(384);

-- Vector index for cosine similarity search (IVFFlat)
-- Note: IVFFlat requires at least 1 row with a non-null embedding to build.
-- For small datasets (<1000 rows), Postgres will fallback to sequential scan which is fine.
CREATE INDEX "venues_embedding_idx" ON "venues" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 10);
