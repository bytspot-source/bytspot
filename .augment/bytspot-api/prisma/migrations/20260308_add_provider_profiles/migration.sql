-- CreateTable: host_profiles
CREATE TABLE "host_profiles" (
    "id"             TEXT NOT NULL,
    "user_id"        TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'draft',
    "current_step"   INTEGER NOT NULL DEFAULT 1,
    "onboarding_data" JSONB,
    "submitted_at"   TIMESTAMP(3),
    "approved_at"    TIMESTAMP(3),
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "host_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: valet_profiles
CREATE TABLE "valet_profiles" (
    "id"                     TEXT NOT NULL,
    "user_id"                TEXT NOT NULL,
    "status"                 TEXT NOT NULL DEFAULT 'draft',
    "agreement_accepted_at"  TIMESTAMP(3),
    "profile_data"           JSONB,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "valet_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: host_profiles.user_id unique
CREATE UNIQUE INDEX "host_profiles_user_id_key" ON "host_profiles"("user_id");

-- CreateIndex: valet_profiles.user_id unique
CREATE UNIQUE INDEX "valet_profiles_user_id_key" ON "valet_profiles"("user_id");

-- AddForeignKey: host_profiles -> users
ALTER TABLE "host_profiles" ADD CONSTRAINT "host_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: valet_profiles -> users
ALTER TABLE "valet_profiles" ADD CONSTRAINT "valet_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

