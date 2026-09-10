-- Additive tombstone: keep the existing creator/idempotency unique key and
-- every item/participant/supply row. Deleted Plans are never resurrected.
ALTER TABLE "plans" ADD COLUMN "deleted_at" TIMESTAMP(3);
