ALTER TABLE "parties"
  ADD COLUMN "cover_image_url" TEXT,
  ADD COLUMN "photo_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];