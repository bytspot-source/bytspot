-- A Party's own coordinates, so a published Party can reach a geographic
-- surface. Until now the only location a Party carried was `venue_name` (free
-- text) and an optional `arrival_venue_id`, and binding an arrival venue
-- requires an already-registered Venue whose name matches exactly. The hosts
-- being onboarded first — pop-ups, cottages, creators — have no such Venue
-- row, so they had no location at all and could never be filtered into
-- Discover or Home.
--
-- Additive and nullable. Existing rows keep NULL and are simply absent from
-- geographic surfaces, which is the same honest degradation applied
-- everywhere else: no coordinates, no pin, no guessing from free text.
ALTER TABLE "parties" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "parties" ADD COLUMN "lng" DOUBLE PRECISION;

-- Half a coordinate is not a location. A row must carry both or neither,
-- so no query has to defend against a longitude with no latitude.
ALTER TABLE "parties" ADD CONSTRAINT "parties_coordinates_paired"
  CHECK (("lat" IS NULL) = ("lng" IS NULL));

-- Coordinates must be on Earth. A zero/zero row is the classic unresolved
-- placeholder and would otherwise put a Party in the Gulf of Guinea, which
-- the discovery box would happily return to someone sailing past.
ALTER TABLE "parties" ADD CONSTRAINT "parties_coordinates_sane"
  CHECK (
    "lat" IS NULL
    OR ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180
        AND NOT ("lat" = 0 AND "lng" = 0))
  );

-- Discovery filters published parties by a coordinate box and orders by
-- start. Partial: a draft is never discoverable, so it does not belong in
-- the index.
-- Partial, so it carries only rows a geographic surface can return. Follows
-- `users_purge_after_idx`: a partial index has no schema.prisma counterpart.
CREATE INDEX IF NOT EXISTS "parties_discovery_location_idx"
  ON "parties" ("lat", "lng", "starts_at")
  WHERE "status" = 'published' AND "lat" IS NOT NULL;
