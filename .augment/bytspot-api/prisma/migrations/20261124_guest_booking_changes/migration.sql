-- A guest can change a request one business has not answered (CHANGED) and
-- cancel a pay-at-venue booking it accepted (offer CANCELLED, event
-- CANCELLED_BY_GUEST). Widens the allowlists; no rows change.

ALTER TABLE "demand_events" DROP CONSTRAINT IF EXISTS "demand_events_kind_known";
ALTER TABLE "demand_events" ADD CONSTRAINT "demand_events_kind_known"
  CHECK ("kind" IN ('PUBLISHED', 'BROADCAST', 'VIEWED', 'OFFERED', 'DECLINED',
                    'ACCEPTED', 'WITHDRAWN', 'EXPIRED', 'NO_SHOW', 'SETTLED',
                    'CHANGED', 'CANCELLED_BY_GUEST'));

ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_state_known";
ALTER TABLE "offers" ADD CONSTRAINT "offers_state_known"
  CHECK ("state" IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'CANCELLED'));

-- A cancelled booking keeps the snapshot the guest held, as history.
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_bookable_follows_acceptance";
ALTER TABLE "offers" ADD CONSTRAINT "offers_bookable_follows_acceptance"
  CHECK (("state" IN ('ACCEPTED', 'CANCELLED') AND "bookable_id" IS NOT NULL)
      OR ("state" NOT IN ('ACCEPTED', 'CANCELLED') AND "bookable_id" IS NULL));
