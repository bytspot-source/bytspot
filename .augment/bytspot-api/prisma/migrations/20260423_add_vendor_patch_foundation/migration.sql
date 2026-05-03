-- CreateEnum: Entity
CREATE TYPE "Entity" AS ENUM (
    'BYTSPOT_HOLDINGS',
    'BYTSPOT_INC',
    'VENDOR_SERVICES',
    'EXPERIENCES',
    'PROPERTY_REIT',
    'FOUNDATION'
);

-- CreateTable: hardware_patches
CREATE TABLE "hardware_patches" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "tag_type" TEXT NOT NULL DEFAULT 'NTAG424_DNA',
    "sdm_key_ref" TEXT,
    "read_counter" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unbound',
    "entity" "Entity" NOT NULL DEFAULT 'BYTSPOT_INC',
    "binding_type" TEXT,
    "binding_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hardware_patches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hardware_patches_uid_key" ON "hardware_patches"("uid");
CREATE INDEX "hardware_patches_status_idx" ON "hardware_patches"("status");
CREATE INDEX "hardware_patches_binding_type_binding_id_idx" ON "hardware_patches"("binding_type", "binding_id");

-- CreateTable: vendors
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL DEFAULT 'VENDOR_SERVICES',
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT,
    "stripe_account_id" TEXT,
    "onboarding_status" TEXT NOT NULL DEFAULT 'pending',
    "commission_bps" INTEGER NOT NULL DEFAULT 800,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendors_stripe_account_id_key" ON "vendors"("stripe_account_id");
CREATE INDEX "vendors_user_id_idx" ON "vendors"("user_id");
CREATE INDEX "vendors_entity_idx" ON "vendors"("entity");

ALTER TABLE "vendors"
ADD CONSTRAINT "vendors_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: vendor_services
CREATE TABLE "vendor_services" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "duration_mins" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "patch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_services_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vendor_services_vendor_id_status_idx" ON "vendor_services"("vendor_id", "status");
CREATE INDEX "vendor_services_patch_id_idx" ON "vendor_services"("patch_id");

ALTER TABLE "vendor_services"
ADD CONSTRAINT "vendor_services_vendor_id_fkey"
FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vendor_services"
ADD CONSTRAINT "vendor_services_patch_id_fkey"
FOREIGN KEY ("patch_id") REFERENCES "hardware_patches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: bookings
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "price_cents" INTEGER NOT NULL,
    "platform_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stripe_payment_intent_id" TEXT,
    "ict_jti" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bookings_stripe_payment_intent_id_key" ON "bookings"("stripe_payment_intent_id");
CREATE UNIQUE INDEX "bookings_ict_jti_key" ON "bookings"("ict_jti");
CREATE INDEX "bookings_user_id_created_at_idx" ON "bookings"("user_id", "created_at" DESC);
CREATE INDEX "bookings_vendor_id_status_idx" ON "bookings"("vendor_id", "status");
CREATE INDEX "bookings_service_id_idx" ON "bookings"("service_id");

ALTER TABLE "bookings"
ADD CONSTRAINT "bookings_service_id_fkey"
FOREIGN KEY ("service_id") REFERENCES "vendor_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bookings"
ADD CONSTRAINT "bookings_vendor_id_fkey"
FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bookings"
ADD CONSTRAINT "bookings_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: liability_records
CREATE TABLE "liability_records" (
    "id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "gcs_object_path" TEXT,
    "gcs_generation" BIGINT,
    "ipfs_cid" TEXT,
    "locked_until" TIMESTAMP(3),
    "entity" "Entity" NOT NULL DEFAULT 'BYTSPOT_INC',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liability_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "liability_records_sha256_key" ON "liability_records"("sha256");
CREATE INDEX "liability_records_resource_type_resource_id_idx" ON "liability_records"("resource_type", "resource_id");
CREATE INDEX "liability_records_entity_created_at_idx" ON "liability_records"("entity", "created_at" DESC);

-- CreateTable: compliance_logs
CREATE TABLE "compliance_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "entity" "Entity" NOT NULL DEFAULT 'BYTSPOT_INC',
    "procedure" TEXT NOT NULL,
    "frameworks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "policy_context" JSONB,
    "state_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outcome" TEXT NOT NULL DEFAULT 'allow',
    "reason" TEXT,
    "request_ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "compliance_logs_user_id_created_at_idx" ON "compliance_logs"("user_id", "created_at" DESC);
CREATE INDEX "compliance_logs_procedure_created_at_idx" ON "compliance_logs"("procedure", "created_at" DESC);
CREATE INDEX "compliance_logs_entity_created_at_idx" ON "compliance_logs"("entity", "created_at" DESC);

ALTER TABLE "compliance_logs"
ADD CONSTRAINT "compliance_logs_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
