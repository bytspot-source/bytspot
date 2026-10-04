-- Production was stranded when the original party-session migration was
-- replaced after it had already been applied. The live table therefore lacks
-- the withdrawal column expected by events.invite. Add only that proven-missing
-- contract; do not rebuild or rewrite the table.
ALTER TABLE "party_sessions" ADD COLUMN IF NOT EXISTS "withdrawn_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "party_sessions_party_id_withdrawn_at_idx"
  ON "party_sessions"("party_id", "withdrawn_at");
