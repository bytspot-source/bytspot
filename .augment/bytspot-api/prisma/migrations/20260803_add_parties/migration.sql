-- Party Operating System: durable Host Studio drafts and Party Pass publishing.
CREATE TABLE "parties" (
    "id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "draft_fingerprint" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "venue_name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "access_mode" TEXT NOT NULL,
    "required_membership_tier" TEXT NOT NULL DEFAULT 'green',
    "audience_circle_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "itinerary" JSONB NOT NULL,
    "ticket_tiers" JSONB NOT NULL,
    "cohosts" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'host-studio',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "pass_code" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "parties_pass_code_key" ON "parties"("pass_code");
CREATE UNIQUE INDEX "parties_host_id_idempotency_key_key" ON "parties"("host_id", "idempotency_key");
CREATE INDEX "parties_host_id_status_created_at_idx" ON "parties"("host_id", "status", "created_at" DESC);
CREATE INDEX "parties_status_starts_at_idx" ON "parties"("status", "starts_at");

ALTER TABLE "parties" ADD CONSTRAINT "parties_host_id_fkey"
  FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;