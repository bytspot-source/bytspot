-- Provider subjects are durable identities; raw provider tokens are never stored.
CREATE TYPE "AuthProvider" AS ENUM ('apple', 'google');

CREATE TABLE "provider_identities" (
    "id" TEXT NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_identities_provider_subject_key"
    ON "provider_identities"("provider", "subject");
CREATE INDEX "provider_identities_user_id_idx"
    ON "provider_identities"("user_id");

ALTER TABLE "provider_identities"
    ADD CONSTRAINT "provider_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
