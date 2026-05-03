ALTER TABLE "point_transactions" ADD COLUMN "entity" "Entity" NOT NULL DEFAULT 'BYTSPOT_INC';

ALTER TABLE "bookings" ADD COLUMN "entity" "Entity" NOT NULL DEFAULT 'VENDOR_SERVICES';
ALTER TABLE "bookings" ADD COLUMN "stripe_session_id" TEXT;
ALTER TABLE "bookings" ADD COLUMN "stripe_transfer_destination" TEXT;

CREATE INDEX "point_transactions_entity_category_created_at_idx" ON "point_transactions"("entity", "category", "created_at" DESC);
CREATE UNIQUE INDEX "bookings_stripe_session_id_key" ON "bookings"("stripe_session_id");
CREATE INDEX "bookings_entity_status_idx" ON "bookings"("entity", "status");