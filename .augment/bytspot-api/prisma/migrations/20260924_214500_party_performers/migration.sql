-- Additive only. Host proposals never carry organizer-authored payment data.
CREATE TABLE "party_performers" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "invited_user_id" TEXT NOT NULL,
  "confirmed_user_id" TEXT,
  "display_name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "tip_handles" JSONB NOT NULL DEFAULT '[]',
  "confirmed_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_performers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_performers_role_check" CHECK ("role" IN ('dj', 'mc')),
  CONSTRAINT "party_performers_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'withdrawn', 'removed')),
  CONSTRAINT "party_performers_identity_check" CHECK ("confirmed_user_id" IS NULL OR "confirmed_user_id" = "invited_user_id"),
  CONSTRAINT "party_performers_consent_check" CHECK (
    ("status" = 'accepted' AND "confirmed_user_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)
    OR ("status" <> 'accepted' AND "tip_handles" = '[]'::jsonb AND "confirmed_at" IS NULL)
  ),
  CONSTRAINT "party_performers_tips_array_check" CHECK (jsonb_typeof("tip_handles") = 'array' AND jsonb_array_length("tip_handles") <= 3),
  CONSTRAINT "party_performers_version_check" CHECK ("version" >= 0),
  CONSTRAINT "party_performers_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_performers_confirmed_user_id_fkey" FOREIGN KEY ("confirmed_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "party_performers_party_id_status_idx" ON "party_performers"("party_id", "status");
CREATE INDEX "party_performers_invited_user_id_status_created_at_idx" ON "party_performers"("invited_user_id", "status", "created_at");
CREATE INDEX "party_performers_confirmed_user_id_idx" ON "party_performers"("confirmed_user_id");
-- A concurrent duplicate proposal cannot create two active credits for a role.
CREATE UNIQUE INDEX "party_performers_active_identity_role_key"
  ON "party_performers"("party_id", "invited_user_id", "role")
  WHERE "status" IN ('pending', 'accepted');
