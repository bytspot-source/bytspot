-- WS-Social Phase 1: connection invitations, privacy-preserving contact
-- hashes (salted SHA-256 only — raw contact data is never stored), owner-run
-- circles, and the double-opt-in People You Met encounter table.
CREATE TABLE "social_invitations" (
  "id" TEXT NOT NULL,
  "from_user_id" TEXT NOT NULL,
  "to_user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_at" TIMESTAMP(3),

  CONSTRAINT "social_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_invitations_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined'))
);

CREATE UNIQUE INDEX "social_invitations_from_user_id_to_user_id_key" ON "social_invitations"("from_user_id", "to_user_id");
-- Race safety for reciprocal invites: at most one active (pending/accepted)
-- invitation may exist per unordered user pair, regardless of direction.
-- Declined rows are excluded so a declined invite never blocks the other
-- member from extending their own. Expression indexes are not expressible in
-- schema.prisma; the router handles the unique violation as a conflict.
CREATE UNIQUE INDEX "social_invitations_pair_active_key" ON "social_invitations"(LEAST("from_user_id", "to_user_id"), GREATEST("from_user_id", "to_user_id")) WHERE "status" IN ('pending', 'accepted');
CREATE INDEX "social_invitations_from_user_id_status_idx" ON "social_invitations"("from_user_id", "status");
CREATE INDEX "social_invitations_to_user_id_status_idx" ON "social_invitations"("to_user_id", "status");

ALTER TABLE "social_invitations"
  ADD CONSTRAINT "social_invitations_from_user_id_fkey"
  FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_invitations"
  ADD CONSTRAINT "social_invitations_to_user_id_fkey"
  FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "contact_hashes" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "hashed_contact" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contact_hashes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_hashes_user_id_hashed_contact_key" ON "contact_hashes"("user_id", "hashed_contact");
CREATE INDEX "contact_hashes_hashed_contact_idx" ON "contact_hashes"("hashed_contact");

ALTER TABLE "contact_hashes"
  ADD CONSTRAINT "contact_hashes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "social_circles" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "social_circles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "social_circles_owner_id_idx" ON "social_circles"("owner_id");

ALTER TABLE "social_circles"
  ADD CONSTRAINT "social_circles_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "social_circle_members" (
  "id" TEXT NOT NULL,
  "circle_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "social_circle_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "social_circle_members_circle_id_user_id_key" ON "social_circle_members"("circle_id", "user_id");
CREATE INDEX "social_circle_members_user_id_idx" ON "social_circle_members"("user_id");

ALTER TABLE "social_circle_members"
  ADD CONSTRAINT "social_circle_members_circle_id_fkey"
  FOREIGN KEY ("circle_id") REFERENCES "social_circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_circle_members"
  ADD CONSTRAINT "social_circle_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "party_encounter_opt_ins" (
  "id" TEXT NOT NULL,
  "party_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "party_encounter_opt_ins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_encounter_opt_ins_party_id_user_id_key" ON "party_encounter_opt_ins"("party_id", "user_id");
CREATE INDEX "party_encounter_opt_ins_user_id_idx" ON "party_encounter_opt_ins"("user_id");

ALTER TABLE "party_encounter_opt_ins"
  ADD CONSTRAINT "party_encounter_opt_ins_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_encounter_opt_ins"
  ADD CONSTRAINT "party_encounter_opt_ins_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
