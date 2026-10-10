-- Report and block (App Review Guideline 1.2).
ALTER TABLE "users" ADD COLUMN "suspended_at" TIMESTAMP(3);
ALTER TABLE "parties" ADD COLUMN "moderation_hidden_at" TIMESTAMP(3);
ALTER TABLE "reviews" ADD COLUMN "moderation_hidden_at" TIMESTAMP(3);
ALTER TABLE "private_sales" ADD COLUMN "moderation_hidden_at" TIMESTAMP(3);

CREATE TABLE "user_blocks" (
    "id" TEXT NOT NULL,
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_blocks_blocker_id_blocked_id_key" ON "user_blocks"("blocker_id", "blocked_id");
CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks"("blocked_id");

ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "content_reports" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "content_reports_reporter_id_target_kind_target_id_key" ON "content_reports"("reporter_id", "target_kind", "target_id");
CREATE INDEX "content_reports_status_created_at_idx" ON "content_reports"("status", "created_at");
CREATE INDEX "content_reports_target_kind_target_id_idx" ON "content_reports"("target_kind", "target_id");
CREATE INDEX "content_reports_owner_id_idx" ON "content_reports"("owner_id");

ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
