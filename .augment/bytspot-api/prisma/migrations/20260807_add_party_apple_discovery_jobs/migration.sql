CREATE TABLE "party_apple_discovery_jobs" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "host_tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "request" JSONB NOT NULL,
    "apple_experience_id" TEXT,
    "failure_code" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_apple_discovery_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_apple_discovery_jobs_party_id_key" ON "party_apple_discovery_jobs"("party_id");
CREATE UNIQUE INDEX "party_apple_discovery_jobs_party_id_idempotency_key_key" ON "party_apple_discovery_jobs"("party_id", "idempotency_key");
CREATE INDEX "party_apple_discovery_jobs_status_updated_at_idx" ON "party_apple_discovery_jobs"("status", "updated_at" DESC);
CREATE INDEX "party_apple_discovery_jobs_requested_by_user_id_created_at_idx" ON "party_apple_discovery_jobs"("requested_by_user_id", "created_at" DESC);

ALTER TABLE "party_apple_discovery_jobs" ADD CONSTRAINT "party_apple_discovery_jobs_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_apple_discovery_jobs" ADD CONSTRAINT "party_apple_discovery_jobs_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;