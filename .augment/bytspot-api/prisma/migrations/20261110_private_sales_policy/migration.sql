-- REA review 2026-11-10 (PS1): private-sale categories and ticket face value.
ALTER TABLE "private_sales" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "private_sales" ADD COLUMN "face_value_cents" INTEGER;
