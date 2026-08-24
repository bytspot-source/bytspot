-- The visit cooldown looks up the member's most recent paid check-in at one
-- venue. Without this index that lookup walks the member's entire history
-- whenever the answer is "never", which is the common case.
CREATE INDEX IF NOT EXISTS "check_ins_user_id_venue_id_created_at_idx"
  ON "check_ins" ("user_id", "venue_id", "created_at" DESC);
