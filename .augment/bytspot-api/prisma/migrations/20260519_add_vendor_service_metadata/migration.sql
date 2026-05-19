ALTER TABLE "vendor_services"
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'General',
  ADD COLUMN "max_guests" INTEGER,
  ADD COLUMN "patch_required" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "vendor_services_category_idx" ON "vendor_services"("category");