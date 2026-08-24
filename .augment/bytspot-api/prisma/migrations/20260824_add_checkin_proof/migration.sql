-- Check-ins now record how they were established. Existing rows were taps with
-- no coordinate and no verification, so the default states exactly that rather
-- than grandfathering them into a number we would later have to defend.
ALTER TABLE "check_ins" ADD COLUMN "proof" TEXT NOT NULL DEFAULT 'self_reported';
ALTER TABLE "check_ins" ADD COLUMN "distance_m" INTEGER;

CREATE INDEX "check_ins_venue_id_proof_created_at_idx" ON "check_ins" ("venue_id", "proof", "created_at" DESC);
