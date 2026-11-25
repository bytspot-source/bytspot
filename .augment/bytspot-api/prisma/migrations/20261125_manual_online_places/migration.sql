-- Places a Bytspot admin lists by hand because Google has no listing, such as
-- online businesses. Every existing venue reads as a walk-in place with no note.
ALTER TABLE "venues" ADD COLUMN "online_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "venues" ADD COLUMN "website" TEXT;
ALTER TABLE "venues" ADD COLUMN "verification_note" TEXT;
ALTER TABLE "venues" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "venues" ADD COLUMN "verified_by_user_id" TEXT;

ALTER TABLE "venues" ADD CONSTRAINT "venues_verification_note_check" CHECK ("verification_note" IS NULL OR char_length("verification_note") <= 1000);
ALTER TABLE "venues" ADD CONSTRAINT "venues_website_check" CHECK ("website" IS NULL OR "website" ~ '^https://');
