CREATE TABLE "parties" (
  "id" TEXT NOT NULL,
  "host_user_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "template_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "tagline" TEXT NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "venue_name" TEXT NOT NULL,
  "capacity" INTEGER NOT NULL,
  "access_mode" TEXT NOT NULL,
  "required_membership_tier" TEXT NOT NULL,
  "audience_circle_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "itinerary" JSONB NOT NULL,
  "ticket_tiers" JSONB NOT NULL,
  "cohosts" JSONB NOT NULL,
  "template_config" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "pass_code" TEXT,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "parties_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "parties_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "parties_host_user_id_idempotency_key_key" ON "parties"("host_user_id", "idempotency_key");
CREATE UNIQUE INDEX "parties_pass_code_key" ON "parties"("pass_code");
CREATE INDEX "parties_host_user_id_status_idx" ON "parties"("host_user_id", "status");
CREATE INDEX "parties_status_starts_at_idx" ON "parties"("status", "starts_at");

CREATE TABLE "party_media" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "mime_type" TEXT NOT NULL,
  "bytes" BYTEA NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_media_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_media_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "party_media_party_id_kind_position_key" ON "party_media"("party_id", "kind", "position");
CREATE INDEX "party_media_party_id_idx" ON "party_media"("party_id");