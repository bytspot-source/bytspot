-- Growth tab: taps on each block of the app's Home screen. Block and time only.
CREATE TABLE IF NOT EXISTS "home_taps" (
  "id" TEXT NOT NULL,
  "block" TEXT NOT NULL,
  "tapped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "home_taps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "home_taps_block" CHECK ("block" IN ('todays_pick', 'start_here', 'near_you_now', 'weather', 'music', 'explore', 'tonight_events', 'local_services'))
);
CREATE INDEX IF NOT EXISTS "home_taps_tapped_at_idx" ON "home_taps"("tapped_at");
