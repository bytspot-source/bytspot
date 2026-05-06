ALTER TABLE "users"
ADD COLUMN "google_subject" TEXT,
ADD COLUMN "auth_provider" TEXT NOT NULL DEFAULT 'password';

CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");
