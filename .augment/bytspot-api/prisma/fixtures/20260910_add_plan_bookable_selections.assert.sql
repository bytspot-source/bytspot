-- Executed by the per-migration CI fixture runner against disposable Postgres.
-- Roll back behavioral rows: this fixture must never be used as seed inventory.
BEGIN;
DO $$
DECLARE needed TEXT;
BEGIN
  FOREACH needed IN ARRAY ARRAY['coffee_spot_id', 'selection_key'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'plan_items' AND column_name = needed AND is_nullable = 'YES') THEN
      RAISE EXCEPTION 'missing nullable plan_items column: %', needed;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'plans' AND column_name = 'bookable_creation_hash' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'missing nullable creation hash';
  END IF;
  FOREACH needed IN ARRAY ARRAY['plan_items_plan_id_selection_key_key', 'plan_items_coffee_spot_id_idx'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = needed) THEN RAISE EXCEPTION 'missing index: %', needed; END IF;
  END LOOP;
  FOREACH needed IN ARRAY ARRAY['plan_items_selection_supply_check', 'plan_items_coffee_selection_request_check', 'plan_items_selection_snapshot_check', 'plan_items_single_supply_check', 'plan_items_no_supply_no_promise_check'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = needed) THEN RAISE EXCEPTION 'missing constraint: %', needed; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.referential_constraints WHERE constraint_name = 'plan_items_coffee_spot_id_fkey' AND delete_rule = 'RESTRICT') THEN
    RAISE EXCEPTION 'coffee spot identity must survive (restrict deletion)';
  END IF;
END $$;

INSERT INTO users (id, email, password, created_at, updated_at)
VALUES ('selection-fixture-user', 'selection-fixture@example.invalid', 'not-a-login', now(), now());
INSERT INTO plans (id, creator_user_id, idempotency_key, title, intent, join_token, updated_at)
VALUES ('selection-fixture-plan', 'selection-fixture-user', 'selection-fixture-key', 'Fixture', 'Fixture', 'selection-fixture-link', now()),
       ('selection-fixture-plan-2', 'selection-fixture-user', 'selection-fixture-key-2', 'Fixture', 'Fixture', 'selection-fixture-link-2', now());
INSERT INTO coffee_spots (id, name, updated_at) VALUES ('selection-fixture-spot', 'SQL fixture only', now());
INSERT INTO bookables (id, source_kind, capability, tier_name, capacity, fulfillment, updated_at)
VALUES ('BYT-coffee-fixture-1', 'coffee', 'request', 'SQL fixture only', 0, '{"coffeeSpotId":"selection-fixture-spot"}', now()),
       ('BYT-coffee-fixture-2', 'coffee', 'request', 'SQL fixture only', 0, '{"coffeeSpotId":"selection-fixture-spot"}', now()),
       ('BYT-coffee-fixture-duplicate', 'coffee', 'request', 'SQL fixture only', 0, '{"coffeeSpotId":"selection-fixture-spot"}', now());
INSERT INTO plan_items (id, plan_id, need_kind, title, coffee_spot_id, selection_key, capability, bookable_id, updated_at)
VALUES ('selection-fixture-item', 'selection-fixture-plan', 'coffee', 'SQL fixture only', 'selection-fixture-spot', 'coffeeSpot:selection-fixture-spot', 'request', 'BYT-coffee-fixture-1', now()),
       ('selection-fixture-item-2', 'selection-fixture-plan-2', 'coffee', 'SQL fixture only', 'selection-fixture-spot', 'coffeeSpot:selection-fixture-spot', 'request', 'BYT-coffee-fixture-2', now());
-- Multiple legacy NULL keys are allowed, even on one Plan.
INSERT INTO plan_items (id, plan_id, need_kind, title, updated_at)
VALUES ('selection-fixture-legacy-1', 'selection-fixture-plan', 'coffee', 'Reference', now()),
       ('selection-fixture-legacy-2', 'selection-fixture-plan', 'coffee', 'Reference', now());

DO $$
BEGIN
  IF (SELECT bookable_creation_hash FROM plans WHERE id = 'selection-fixture-plan') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy creates must have no payload hash';
  END IF;
  BEGIN
    INSERT INTO plan_items (id, plan_id, need_kind, title, selection_key, bookable_id, updated_at)
    VALUES ('selection-fixture-duplicate', 'selection-fixture-plan', 'coffee', 'Duplicate', 'coffeeSpot:selection-fixture-spot', 'BYT-coffee-fixture-duplicate', now());
    RAISE EXCEPTION 'duplicate selection allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  -- Cancelled rows retain uniqueness to protect against delayed retries.
  UPDATE plan_items SET status = 'cancelled' WHERE id = 'selection-fixture-item';
  BEGIN
    INSERT INTO plan_items (id, plan_id, need_kind, title, selection_key, bookable_id, updated_at)
    VALUES ('selection-fixture-duplicate', 'selection-fixture-plan', 'coffee', 'Duplicate', 'coffeeSpot:selection-fixture-spot', 'BYT-coffee-fixture-duplicate', now());
    RAISE EXCEPTION 'cancelled duplicate selection allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET capability = 'book' WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'unreserved coffee advertised booking capability';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET status = 'held' WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'draft coffee became held';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET status = 'booked' WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'draft coffee became booked';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET party_id = 'any-party' WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'mixed coffee/party supplies allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET coffee_reservation_id = 'any-reservation' WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'mixed coffee/reservation supplies allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET coffee_spot_id = 'missing-spot', selection_key = 'coffeeSpot:missing-spot' WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'orphan coffee identity allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    DELETE FROM coffee_spots WHERE id = 'selection-fixture-spot';
    RAISE EXCEPTION 'durable coffee identity was deleted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  IF EXISTS (SELECT 1 FROM coffee_reservations WHERE requested_by_user_id = 'selection-fixture-user')
    OR EXISTS (SELECT 1 FROM party_guests WHERE user_id = 'selection-fixture-user') THEN
    RAISE EXCEPTION 'a selection implicitly reserved supply';
  END IF;
  BEGIN
    UPDATE plan_items SET bookable_id = NULL WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'selection lost its common snapshot';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET selection_key = NULL WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'unreserved coffee lost its stable identity';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plan_items SET coffee_spot_id = NULL WHERE id = 'selection-fixture-item';
    RAISE EXCEPTION 'supply-free request allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

-- Explicit fulfillment upgrades the existing item and BYT handle, without
-- leaving both spot and reservation FKs populated or tripping orphan downgrade.
INSERT INTO coffee_reservations (id, coffee_spot_id, requested_by_user_id, idempotency_key, party_size, requested_for, hold_expires_at, updated_at)
VALUES ('selection-fixture-reservation', 'selection-fixture-spot', 'selection-fixture-user', 'fixture-reservation-key', 2, now(), now() + interval '15 minutes', now());
UPDATE bookables SET capacity = 1, fulfillment = '{"coffeeReservationId":"selection-fixture-reservation"}'
WHERE id = 'BYT-coffee-fixture-2';
UPDATE plan_items SET coffee_spot_id = NULL, coffee_reservation_id = 'selection-fixture-reservation'
WHERE id = 'selection-fixture-item-2';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_items WHERE id = 'selection-fixture-item-2'
    AND coffee_spot_id IS NULL AND coffee_reservation_id = 'selection-fixture-reservation'
    AND capability = 'request' AND status = 'available'
    AND selection_key = 'coffeeSpot:selection-fixture-spot' AND bookable_id = 'BYT-coffee-fixture-2') THEN
    RAISE EXCEPTION 'reservation upgrade changed item identity or resurrected/downgraded state';
  END IF;
END $$;
ROLLBACK;
