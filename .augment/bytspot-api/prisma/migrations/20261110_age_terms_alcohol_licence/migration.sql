-- REA review 2026-11-10 (X6, P1, V2). All nullable: every existing member
-- reads as "age unknown, current terms not yet accepted", and every existing
-- business as "no verified alcohol licence", so nothing is granted by default.
ALTER TABLE "users" ADD COLUMN "birth_date" DATE;
ALTER TABLE "users" ADD COLUMN "age_confirmed_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "terms_version" TEXT;
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" TIMESTAMP(3);

ALTER TABLE "vendor_sellers" ADD COLUMN "alcohol_licence_number" TEXT;
ALTER TABLE "vendor_sellers" ADD COLUMN "alcohol_licence_verified_at" TIMESTAMP(3);
ALTER TABLE "vendor_sellers" ADD COLUMN "alcohol_licence_verified_by_user_id" TEXT;
ALTER TABLE "vendor_sellers" ADD CONSTRAINT "vendor_sellers_alcohol_licence_number_check" CHECK ("alcohol_licence_number" IS NULL OR char_length("alcohol_licence_number") <= 80);
