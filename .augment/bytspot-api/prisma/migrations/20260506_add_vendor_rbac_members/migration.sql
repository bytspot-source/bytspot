-- Add deterministic Provider/Vendor workspace RBAC roles.
CREATE TYPE "VendorWorkspaceRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF');

CREATE TABLE "vendor_members" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "VendorWorkspaceRole" NOT NULL DEFAULT 'STAFF',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_members_vendor_id_user_id_key" ON "vendor_members"("vendor_id", "user_id");
CREATE INDEX "vendor_members_user_id_role_idx" ON "vendor_members"("user_id", "role");
CREATE INDEX "vendor_members_vendor_id_role_idx" ON "vendor_members"("vendor_id", "role");

ALTER TABLE "vendor_members"
ADD CONSTRAINT "vendor_members_vendor_id_fkey"
FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vendor_members"
ADD CONSTRAINT "vendor_members_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing vendor owners so current workspaces keep full access.
INSERT INTO "vendor_members" ("id", "vendor_id", "user_id", "role", "created_at", "updated_at")
SELECT concat('vm_', md5(random()::text || clock_timestamp()::text || "id")), "id", "user_id", 'OWNER', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "vendors"
ON CONFLICT ("vendor_id", "user_id") DO NOTHING;
