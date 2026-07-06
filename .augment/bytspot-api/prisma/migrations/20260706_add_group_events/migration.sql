-- Group Events: private RSVP guest lists for App Clip invites.
-- Hosts create an event keyed by its invite slug; guests join after
-- Sign in with Apple. Open events join instantly; approval events go pending.

-- CreateTable: group_events
CREATE TABLE "group_events" (
    "id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "group_type" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'green',
    "timing" TEXT NOT NULL DEFAULT 'now',
    "scheduled_date" TEXT,
    "location" TEXT,
    "theme" TEXT,
    "instagram_handle" TEXT,
    "allow_nearby_offers" BOOLEAN NOT NULL DEFAULT true,
    "approval_mode" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable: group_event_guests
CREATE TABLE "group_event_guests" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'joined',
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_event_guests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: host event listing.
CREATE INDEX "group_events_host_id_created_at_idx" ON "group_events"("host_id", "created_at" DESC);

-- CreateIndex: one membership per (event, user) pair.
CREATE UNIQUE INDEX "group_event_guests_event_id_user_id_key" ON "group_event_guests"("event_id", "user_id");

-- CreateIndex: guest/pending list lookups by event + status.
CREATE INDEX "group_event_guests_event_id_status_idx" ON "group_event_guests"("event_id", "status");

-- CreateIndex: a user's joined events.
CREATE INDEX "group_event_guests_user_id_created_at_idx" ON "group_event_guests"("user_id", "created_at" DESC);

-- AddForeignKey: group_events.host_id → users
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: group_event_guests.event_id → group_events
ALTER TABLE "group_event_guests" ADD CONSTRAINT "group_event_guests_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "group_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: group_event_guests.user_id → users
ALTER TABLE "group_event_guests" ADD CONSTRAINT "group_event_guests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
