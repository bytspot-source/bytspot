-- Vendor intent, one word at a time.
--
-- Capability today is inferred from which kind of row exists: a party means
-- book, a coffee reservation means request. That reads the seller's data and
-- guesses what they meant. The model this replaces it with is that the seller
-- says what they are offering and the platform holds them to it.
--
-- The vocabulary opens one word at a time, and a word is only added when the
-- rail behind it exists. Today exactly one does: `request` — ask, receive an
-- offer, accept it — because demand, offers, holds and acceptance are all
-- built. `book`, `order` and `redirect` are deliberately absent from the CHECK
-- until the thing they promise can actually be honoured. A vocabulary that can
-- name a promise the platform cannot keep is how the trust gate stops meaning
-- anything.
--
-- `none` is the other half of a gate. A column that can only say yes does not
-- gate anything, and a seller who wants to stop taking asks on a window should
-- not have to deactivate or delete it to do so. It promises nothing, which is
-- why it is safe to allow before any of the other words are.

ALTER TABLE "vendor_availability_windows"
  ADD COLUMN IF NOT EXISTS "intent" TEXT NOT NULL DEFAULT 'request';

-- Existing windows already do exactly this: they sit in the feed and answer
-- demand with offers. The default states what was already true rather than
-- granting anything new.
DO $$ BEGIN
  ALTER TABLE "vendor_availability_windows" ADD CONSTRAINT "vendor_windows_intent_known"
    CHECK ("intent" IN ('request', 'none'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The feed filters on it, so it is read on every demand broadcast.
CREATE INDEX IF NOT EXISTS "vendor_availability_windows_intent_active_idx"
  ON "vendor_availability_windows" ("intent", "active");
