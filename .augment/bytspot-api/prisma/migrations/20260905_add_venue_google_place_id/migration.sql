-- Google Place identity for venues created from a host's arrival-destination
-- search. Nullable so seeded/legacy venues are untouched; unique so a place a
-- host binds twice reuses one venue instead of duplicating it.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "google_place_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "venues_google_place_id_key" ON "venues"("google_place_id");
