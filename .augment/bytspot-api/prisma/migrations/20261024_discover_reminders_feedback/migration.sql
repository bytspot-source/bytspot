-- Discover opt-in for approval doors, idempotent scheduled pushes, and member feedback.
-- Existing parties stay off Discover: the column defaults to false.
-- AlterTable
ALTER TABLE "parties" ADD COLUMN     "show_on_discover" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "notification_sends" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_dismissals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_sends_sent_at_idx" ON "notification_sends"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_sends_user_id_dedupe_key_key" ON "notification_sends"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "feedback_target_kind_target_id_idx" ON "feedback"("target_kind", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_user_id_target_kind_target_id_key" ON "feedback"("user_id", "target_kind", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_dismissals_user_id_target_kind_target_id_key" ON "feedback_dismissals"("user_id", "target_kind", "target_id");

-- AddForeignKey
ALTER TABLE "notification_sends" ADD CONSTRAINT "notification_sends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_dismissals" ADD CONSTRAINT "feedback_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same bounds the API validates, held by the database too.
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_note_length_check" CHECK ("note" IS NULL OR char_length("note") <= 500);
