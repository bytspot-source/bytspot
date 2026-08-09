-- Individual-host Party Control: trusted social connections, inviteable
-- circles, Party attendance/check-in, and typed Creator Links.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "membership_tier" TEXT NOT NULL DEFAULT 'green';
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "admission_paused_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "social_connections" (
  "id" TEXT NOT NULL,
  "user_low_id" TEXT NOT NULL,
  "user_high_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_connections_user_low_id_fkey" FOREIGN KEY ("user_low_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_connections_user_high_id_fkey" FOREIGN KEY ("user_high_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_connections_user_low_id_user_high_id_key" ON "social_connections"("user_low_id", "user_high_id");
CREATE INDEX IF NOT EXISTS "social_connections_user_low_id_idx" ON "social_connections"("user_low_id");
CREATE INDEX IF NOT EXISTS "social_connections_user_high_id_idx" ON "social_connections"("user_high_id");

CREATE TABLE IF NOT EXISTS "social_circles" (
  "id" TEXT NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "privacy" TEXT NOT NULL DEFAULT 'private',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_circles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_circles_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "social_circles_owner_user_id_idx" ON "social_circles"("owner_user_id");

CREATE TABLE IF NOT EXISTS "social_circle_members" (
  "id" TEXT NOT NULL,
  "circle_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_circle_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_circle_members_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "social_circles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_circle_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_circle_members_circle_id_user_id_key" ON "social_circle_members"("circle_id", "user_id");
CREATE INDEX IF NOT EXISTS "social_circle_members_user_id_idx" ON "social_circle_members"("user_id");

CREATE TABLE IF NOT EXISTS "social_invitations" (
  "id" TEXT NOT NULL,
  "sender_user_id" TEXT NOT NULL,
  "recipient_user_id" TEXT NOT NULL,
  "circle_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_at" TIMESTAMP(3),
  CONSTRAINT "social_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_invitations_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_invitations_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_invitations_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "social_circles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "social_invitations_recipient_user_id_status_idx" ON "social_invitations"("recipient_user_id", "status");
CREATE INDEX IF NOT EXISTS "social_invitations_sender_user_id_status_idx" ON "social_invitations"("sender_user_id", "status");

CREATE TABLE IF NOT EXISTS "party_guests" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "source" TEXT NOT NULL,
  "ticket_tier_name" TEXT,
  "stripe_checkout_session_id" TEXT,
  "attendee_pass_hash" TEXT,
  "attendee_pass_issued_at" TIMESTAMP(3),
  "checked_in_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_guests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_guests_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_guests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "party_guests_party_id_user_id_key" ON "party_guests"("party_id", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "party_guests_stripe_checkout_session_id_key" ON "party_guests"("stripe_checkout_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "party_guests_attendee_pass_hash_key" ON "party_guests"("attendee_pass_hash");
CREATE INDEX IF NOT EXISTS "party_guests_party_id_status_idx" ON "party_guests"("party_id", "status");
CREATE INDEX IF NOT EXISTS "party_guests_party_id_checked_in_at_idx" ON "party_guests"("party_id", "checked_in_at");
CREATE INDEX IF NOT EXISTS "party_guests_user_id_status_idx" ON "party_guests"("user_id", "status");

CREATE TABLE IF NOT EXISTS "creator_links" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "label" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_links_user_id_kind_key" ON "creator_links"("user_id", "kind");
CREATE INDEX IF NOT EXISTS "creator_links_user_id_idx" ON "creator_links"("user_id");

CREATE TABLE IF NOT EXISTS "party_creator_links" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "creator_link_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "party_creator_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_creator_links_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "party_creator_links_creator_link_id_fkey" FOREIGN KEY ("creator_link_id") REFERENCES "creator_links"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "party_creator_links_party_id_creator_link_id_key" ON "party_creator_links"("party_id", "creator_link_id");
CREATE INDEX IF NOT EXISTS "party_creator_links_party_id_idx" ON "party_creator_links"("party_id");

CREATE TABLE IF NOT EXISTS "creator_link_clicks" (
  "id" TEXT NOT NULL,
  "creator_link_id" TEXT NOT NULL,
  "party_link_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creator_link_clicks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_link_clicks_creator_link_id_fkey" FOREIGN KEY ("creator_link_id") REFERENCES "creator_links"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_link_clicks_party_link_id_fkey" FOREIGN KEY ("party_link_id") REFERENCES "party_creator_links"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "creator_link_clicks_creator_link_id_created_at_idx" ON "creator_link_clicks"("creator_link_id", "created_at");
CREATE INDEX IF NOT EXISTS "creator_link_clicks_party_link_id_created_at_idx" ON "creator_link_clicks"("party_link_id", "created_at");