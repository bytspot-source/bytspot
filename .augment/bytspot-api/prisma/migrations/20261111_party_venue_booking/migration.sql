-- Host's choice to show admitted guests how to book the arrival venue.
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "venue_booking_for_guests" BOOLEAN NOT NULL DEFAULT false;
