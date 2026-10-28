-- Request notes: a ticket-tier perk letting a paid guest send a short note to
-- a performer, shown on the stage screen only once accepted.
-- CreateTable
CREATE TABLE "party_request_notes" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "performer_id" TEXT NOT NULL,
    "sender_user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sender_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "decided_by_user_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "played_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_request_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "party_request_notes_party_id_status_accepted_at_idx" ON "party_request_notes"("party_id", "status", "accepted_at");

-- CreateIndex
CREATE INDEX "party_request_notes_party_id_sender_user_id_idx" ON "party_request_notes"("party_id", "sender_user_id");

-- CreateIndex
CREATE INDEX "party_request_notes_performer_id_status_idx" ON "party_request_notes"("performer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "party_request_notes_sender_user_id_idempotency_key_key" ON "party_request_notes"("sender_user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "party_request_notes" ADD CONSTRAINT "party_request_notes_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_request_notes" ADD CONSTRAINT "party_request_notes_performer_id_fkey" FOREIGN KEY ("performer_id") REFERENCES "party_performers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_request_notes" ADD CONSTRAINT "party_request_notes_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

