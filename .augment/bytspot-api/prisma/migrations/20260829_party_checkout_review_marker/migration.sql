-- A row that cannot be refunded automatically needs a human against Stripe's
-- own records. Marking it keeps it out of the automatic refund batch, where it
-- would otherwise occupy a capped slot forever and starve refundable rows.
ALTER TABLE "party_checkouts" ADD COLUMN IF NOT EXISTS "review_required_at" TIMESTAMP(3);
