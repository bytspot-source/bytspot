-- Coffee is Phase 2's second real bookable. Two new tables, one new
-- nullable column on plan_items, one replaced CHECK constraint, one
-- extended trigger. Nothing here backfills; hostile-shapes.sql already
-- covers survival across every migration in the run.
DO $$
DECLARE
  needed TEXT;
BEGIN
  IF to_regclass('public.coffee_spots') IS NULL THEN RAISE EXCEPTION 'coffee_spots table missing'; END IF;
  IF to_regclass('public.coffee_reservations') IS NULL THEN RAISE EXCEPTION 'coffee_reservations table missing'; END IF;

  -- Every finite domain the router rests on must be unstorable, not merely
  -- unwritten. A missing CHECK here is a Phase-2 bypass waiting to happen,
  -- so this fixture enumerates them one by one.
  FOR needed IN
    SELECT unnest(ARRAY[
      'coffee_spots_hold_minutes_check',
      'coffee_reservations_status_check',
      'coffee_reservations_party_size_check',
      -- The old plan_items_no_room_no_promise_check is deliberately absent:
      -- the migration drops it and replaces it with the two-supply variant.
      'plan_items_no_supply_no_promise_check',
      'plan_items_single_supply_check'
    ])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = needed) THEN
      RAISE EXCEPTION 'missing structural constraint: %', needed;
    END IF;
  END LOOP;

  -- The old CHECK must be gone; leaving it would double-guard the details
  -- rule in a way a future edit could accidentally rely on.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_items_no_room_no_promise_check') THEN
    RAISE EXCEPTION 'plan_items_no_room_no_promise_check must be dropped by the coffee migration';
  END IF;

  -- The new supply column and its uniqueness (a coffee reservation is
  -- attached to at most one Plan item).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plan_items' AND column_name = 'coffee_reservation_id'
  ) THEN
    RAISE EXCEPTION 'plan_items.coffee_reservation_id column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'plan_items_coffee_reservation_id_key') THEN
    RAISE EXCEPTION 'plan_items.coffee_reservation_id must be unique';
  END IF;

  -- Idempotency on reservation creation is a per-user uniqueness, not a
  -- global one; two callers may reuse the same key without colliding.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'coffee_reservations_requested_by_user_id_idempotency_key_key') THEN
    RAISE EXCEPTION 'coffee_reservations idempotency uniqueness missing';
  END IF;

  -- Losing the reservation must never delete Plan history.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_name = 'plan_items_coffee_reservation_id_fkey' AND delete_rule = 'SET NULL'
  ) THEN
    RAISE EXCEPTION 'plan_items.coffee_reservation_id must be SET NULL on delete';
  END IF;

  -- The downgrade trigger now watches both supply columns; the DB, not the
  -- application, is what stops an orphaned item from claiming an affordance.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'plan_items' AND t.tgname = 'plan_items_downgrade_orphans'
  ) THEN
    RAISE EXCEPTION 'plan_items_downgrade_orphans trigger missing after coffee migration';
  END IF;
END $$;
