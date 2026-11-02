-- Saved preferences that filter results: places to avoid and a price ceiling.
-- Every existing member avoids nothing and has no ceiling.
ALTER TABLE "user_preferences" ADD COLUMN "avoid" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "user_preferences" ADD COLUMN "price_ceiling" INTEGER;

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_avoid_check"
  CHECK ("avoid" <@ ARRAY['nightclubs', 'bars', 'live_music', 'sports_bars', 'fast_food', 'busy']::TEXT[]);
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_price_ceiling_check"
  CHECK ("price_ceiling" IS NULL OR "price_ceiling" BETWEEN 1 AND 4);
