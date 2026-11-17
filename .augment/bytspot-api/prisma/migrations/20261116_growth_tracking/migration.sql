-- Growth tab: days each member used the app, and Plan/Party share page opens.
CREATE TABLE IF NOT EXISTS "user_active_days" (
  "user_id" TEXT NOT NULL,
  "day" DATE NOT NULL,
  CONSTRAINT "user_active_days_pkey" PRIMARY KEY ("user_id", "day"),
  CONSTRAINT "user_active_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "user_active_days_day_idx" ON "user_active_days"("day");

CREATE TABLE IF NOT EXISTS "share_link_views" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "share_link_views_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "share_link_views_kind" CHECK ("kind" IN ('plan', 'party'))
);
CREATE INDEX IF NOT EXISTS "share_link_views_viewed_at_idx" ON "share_link_views"("viewed_at");
