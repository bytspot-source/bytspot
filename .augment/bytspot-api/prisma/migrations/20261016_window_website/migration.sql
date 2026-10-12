-- A bookable's own website, e.g. a shop's product page. Guests fall back to the place's website.
ALTER TABLE "vendor_availability_windows" ADD COLUMN "website" TEXT;
