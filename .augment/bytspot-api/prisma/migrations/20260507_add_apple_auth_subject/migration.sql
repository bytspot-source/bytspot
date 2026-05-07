-- Add Sign in with Apple subject for App Store Guideline 4.8 compliance.
ALTER TABLE "users" ADD COLUMN "apple_subject" TEXT;

CREATE UNIQUE INDEX "users_apple_subject_key" ON "users"("apple_subject");