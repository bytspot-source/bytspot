-- Host arrival-destination binding from a searched place.
--
-- google_place_id: nullable so seeded/legacy venues are untouched; unique so a
-- place a host binds twice reuses one venue instead of duplicating it.
--
-- discoverable: existing venues are the curated catalog and stay discoverable
-- (DEFAULT true); host-created arrival destinations are written with
-- discoverable = false so a private party's address/coordinates never surface
-- through the public venue list / nearby / slug / similarity / crowd surfaces.
-- The arrival read path (events.arrival.context / handoff) reads the bound
-- venue by id after authorization, so it is unaffected by this flag.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "google_place_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "venues_google_place_id_key" ON "venues"("google_place_id");

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "discoverable" BOOLEAN NOT NULL DEFAULT true;
