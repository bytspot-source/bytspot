-- Plan is the control plane: it holds no inventory and no money, only
-- references. `lifecycle` deliberately omits booked/active/completed, which are
-- derived from the items and the clock so the Plan cannot contradict execution.
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "creator_user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "area_label" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "party_size" INTEGER,
    "needs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lifecycle" TEXT NOT NULL DEFAULT 'proposed',
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id"),
    -- Booked, active, and completed are derived. The database must not be able
    -- to hold them, so a future write path cannot smuggle one in.
    CONSTRAINT "plans_lifecycle_check" CHECK ("lifecycle" IN ('proposed', 'confirmed', 'cancelled'))
);

-- A participant owns exactly one thing: whether they are going.
CREATE TABLE "plan_participants" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'guest',
    "status" TEXT NOT NULL DEFAULT 'invited',
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_participants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_participants_role_check" CHECK ("role" IN ('creator', 'guest')),
    CONSTRAINT "plan_participants_status_check" CHECK ("status" IN ('invited', 'accepted', 'maybe', 'declined', 'removed'))
);

-- Supply attached to a Plan. `capability` is snapshotted from the Discover
-- listing plug at attach time; a 'details' item is a reference, not a booking.
CREATE TABLE "plan_items" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "need_kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "party_id" TEXT,
    "capability" TEXT NOT NULL DEFAULT 'details',
    "status" TEXT NOT NULL DEFAULT 'available',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_items_capability_check" CHECK ("capability" IN ('book', 'request', 'details')),
    CONSTRAINT "plan_items_status_check" CHECK ("status" IN ('available', 'held', 'booked', 'cancelled')),
    -- A reference the user resolves themselves was never booked by Bytspot.
    CONSTRAINT "plan_items_details_never_booked_check" CHECK (NOT ("capability" = 'details' AND "status" = 'booked'))
);

CREATE UNIQUE INDEX "plans_creator_user_id_idempotency_key_key" ON "plans"("creator_user_id", "idempotency_key");
CREATE INDEX "plans_creator_user_id_created_at_idx" ON "plans"("creator_user_id", "created_at" DESC);
CREATE UNIQUE INDEX "plan_participants_plan_id_user_id_key" ON "plan_participants"("plan_id", "user_id");
CREATE INDEX "plan_participants_user_id_created_at_idx" ON "plan_participants"("user_id", "created_at" DESC);
CREATE INDEX "plan_items_plan_id_created_at_idx" ON "plan_items"("plan_id", "created_at");

ALTER TABLE "plans" ADD CONSTRAINT "plans_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_participants" ADD CONSTRAINT "plan_participants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_participants" ADD CONSTRAINT "plan_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
