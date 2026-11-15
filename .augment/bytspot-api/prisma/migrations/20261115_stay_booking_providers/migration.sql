-- Stay booking sites (Airbnb, Hipcamp, Booking.com, BookRetreats). Same shape
-- rule as before; only the provider list grows. Kept in step with
-- src/services/bookingProviders.ts.
ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_booking_link_shape";
ALTER TABLE "venues" ADD CONSTRAINT "venues_booking_link_shape"
  CHECK (
    ("booking_provider" IS NULL AND "booking_url" IS NULL AND "booking_checked_at" IS NULL)
    OR ("booking_provider" IN ('opentable', 'resy', 'tock', 'sevenrooms', 'fareharbor', 'peek', 'xola', 'bookeo', 'vagaro', 'booksy', 'fresha', 'mindbody', 'eventbrite', 'dice', 'parkwhiz', 'spothero', 'blade', 'wheelsup', 'airbnb', 'hipcamp', 'bookingcom', 'bookretreats') AND "booking_url" ~ '^https://'
        AND "booking_checked_at" IS NOT NULL AND "google_place_id" IS NOT NULL)
  );
