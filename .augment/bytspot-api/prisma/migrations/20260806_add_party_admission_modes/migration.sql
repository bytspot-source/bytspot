ALTER TABLE "parties"
  ADD COLUMN "cash_door_price_cents" INTEGER,
  ADD CONSTRAINT "parties_cash_door_price_positive" CHECK ("cash_door_price_cents" IS NULL OR "cash_door_price_cents" > 0),
  ADD CONSTRAINT "parties_cash_door_price_matches_access_mode" CHECK (("access_mode" = 'cash-at-door') = ("cash_door_price_cents" IS NOT NULL));