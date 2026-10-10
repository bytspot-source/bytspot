-- Confirmed emails a member added next to their account email. A row exists
-- only once the emailed code was entered; addresses are stored in lowercase.
CREATE TABLE "user_emails" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_emails_email_key" ON "user_emails"("email");
CREATE INDEX "user_emails_user_id_idx" ON "user_emails"("user_id");

ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
