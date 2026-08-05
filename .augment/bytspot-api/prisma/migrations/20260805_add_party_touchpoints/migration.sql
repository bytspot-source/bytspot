-- Living Party Pass foundation: each published Party can own stable server-issued touchpoints.
CREATE TABLE "party_touchpoints" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lifecycle_policy" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "party_touchpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_touchpoints_reference_key" ON "party_touchpoints"("reference");
CREATE UNIQUE INDEX "party_touchpoints_party_id_kind_key" ON "party_touchpoints"("party_id", "kind");
CREATE INDEX "party_touchpoints_party_id_status_idx" ON "party_touchpoints"("party_id", "status");

ALTER TABLE "party_touchpoints" ADD CONSTRAINT "party_touchpoints_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;