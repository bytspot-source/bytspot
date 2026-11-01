-- Host-declared music on a Party. Every existing Party declares none.
ALTER TABLE "parties" ADD COLUMN "music_kind" TEXT;
ALTER TABLE "parties" ADD COLUMN "music_genres" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "parties" ADD COLUMN "music_set_starts_at" TIMESTAMP(3);

ALTER TABLE "parties" ADD CONSTRAINT "parties_music_kind_check"
  CHECK ("music_kind" IS NULL OR "music_kind" IN ('live', 'dj', 'both'));
ALTER TABLE "parties" ADD CONSTRAINT "parties_music_genres_check"
  CHECK (cardinality("music_genres") <= 2
    AND "music_genres" <@ ARRAY['afrobeats', 'amapiano', 'hip-hop', 'r-and-b', 'jazz', 'reggae-dancehall', 'house', 'gospel', 'latin', 'live-band']::TEXT[]);
-- No genres or set time without music, and a declared kind names a genre.
ALTER TABLE "parties" ADD CONSTRAINT "parties_music_shape_check"
  CHECK (("music_kind" IS NULL AND cardinality("music_genres") = 0 AND "music_set_starts_at" IS NULL)
    OR ("music_kind" IS NOT NULL AND cardinality("music_genres") >= 1));

CREATE INDEX "parties_music_kind_starts_at_idx" ON "parties" ("music_kind", "starts_at") WHERE "music_kind" IS NOT NULL;
