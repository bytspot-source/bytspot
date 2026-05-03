-- CreateTable: audit_logs (NIST PR.PT-1, append-only)
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "vendor_id" TEXT,
    "patch_id" TEXT,
    "uid" TEXT,
    "token_jti" TEXT,
    "venue_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_vendor_id_at_idx" ON "audit_logs"("vendor_id", "at" DESC);
CREATE INDEX "audit_logs_patch_id_at_idx" ON "audit_logs"("patch_id", "at" DESC);
CREATE INDEX "audit_logs_outcome_at_idx" ON "audit_logs"("outcome", "at" DESC);
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateTable: revoked_patches (NIST RS.MI-1)
CREATE TABLE "revoked_patches" (
    "id" TEXT NOT NULL,
    "patch_id" TEXT NOT NULL,
    "vendor_id" TEXT,
    "reason" TEXT,
    "revoked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_patches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "revoked_patches_patch_id_vendor_id_key" ON "revoked_patches"("patch_id", "vendor_id");
CREATE INDEX "revoked_patches_vendor_id_created_at_idx" ON "revoked_patches"("vendor_id", "created_at" DESC);
CREATE INDEX "revoked_patches_created_at_idx" ON "revoked_patches"("created_at" DESC);
