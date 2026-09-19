-- An offer is a slot, and a slot is not longer than a day.
--
-- `offers_shape_sane` bounded duration_mins from below but not above, so a
-- vendor could offer a table for a year. That is not a seating; it is a lease,
-- and nothing in the rail is built to hold capacity that long.
--
-- The bound is also load-bearing for reads. `demand.mine` keeps a booking
-- visible until the held table has finished, which is `starts_at +
-- duration_mins` — arithmetic Prisma cannot express in a `where`. The query
-- therefore prefilters on `starts_at` with a fixed lookback and applies the
-- exact end time in application code. That prefilter is only correct if no
-- offer can run longer than the lookback, so the invariant is enforced here
-- rather than assumed there.
--
-- Replace-in-place: drop-if-exists before add lets a retry through without
-- depending on state left by a failed apply.
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_shape_sane";
ALTER TABLE "offers" ADD CONSTRAINT "offers_shape_sane"
    CHECK ("duration_mins" > 0 AND "duration_mins" <= 1440
           AND "price_cents" >= 0 AND "capacity" >= 1);

-- Availability windows derive offer durations, so an unbounded slot length
-- there would produce an offer that cannot be inserted. Bounded at the source
-- so the vendor is refused when declaring the window, not later when a guest
-- is waiting on an offer that silently fails to write.
ALTER TABLE "vendor_availability_windows" DROP CONSTRAINT IF EXISTS "vendor_windows_shape_sane";
ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_shape_sane"
    CHECK ("slot_minutes" > 0 AND "slot_minutes" <= 1440 AND "lead_time_mins" >= 0
           AND "horizon_days" > 0 AND "price_cents" >= 0 AND "max_guests" >= 1);
