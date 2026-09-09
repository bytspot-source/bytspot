-- A photograph is an endorsement: only a picture Bytspot owns, or one a host
-- uploaded to their own Party, may earn a venue a map pin. Everything borrowed
-- from a listing provider is a grey dot, route-only, attributed where shown.
--
-- Additive and fail-closed. The column is NOT NULL DEFAULT 'borrowed', so every
-- venue that already exists — all of production's current supply, none of which
-- is controlled — lands on the closed side of the gate without a backfill. Pin
-- eligibility is never a column; it is derived from provenance plus the
-- presence of an actual image, so no row can assert a pin it has not earned.
--
-- Every statement is guarded (IF NOT EXISTS / DO $$ … EXCEPTION duplicate_object)
-- so a manual retry after a P3009 clears the migration cleanly.

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "photo_provenance" TEXT NOT NULL DEFAULT 'borrowed';

-- Borrowed imagery must be able to name its source wherever it is rendered.
ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "photo_attribution" TEXT;

-- The domain is closed in the database, not merely in the router: an
-- unrecognised provenance must be unstorable rather than silently trusted.
DO $$ BEGIN
  ALTER TABLE "venues"
    ADD CONSTRAINT "venues_photo_provenance_check"
    CHECK ("photo_provenance" IN ('bytspot_owned', 'party_media', 'borrowed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- A venue may only claim owned provenance if it actually has a photograph.
-- Without this a row could sit in the pin-eligible set with nothing to show,
-- and the map would have to fall back to borrowed imagery to fill the hole.
DO $$ BEGIN
  ALTER TABLE "venues"
    ADD CONSTRAINT "venues_owned_photo_requires_image_check"
    CHECK (
      "photo_provenance" = 'borrowed'
      OR ("image_url" IS NOT NULL AND length(btrim("image_url")) > 0)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The map reads the pin-eligible set on every viewport change; keep it cheap
-- and keep borrowed supply out of the index entirely.
CREATE INDEX IF NOT EXISTS "venues_pin_eligible_idx"
  ON "venues" ("photo_provenance")
  WHERE "photo_provenance" <> 'borrowed';
