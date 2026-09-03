-- The Plan control plane is additive: three new tables, nothing altered.
DO $$
DECLARE
  needed TEXT;
BEGIN
  IF to_regclass('public.plans') IS NULL THEN RAISE EXCEPTION 'plans table missing'; END IF;
  IF to_regclass('public.plan_participants') IS NULL THEN RAISE EXCEPTION 'plan_participants table missing'; END IF;
  IF to_regclass('public.plan_items') IS NULL THEN RAISE EXCEPTION 'plan_items table missing'; END IF;

  -- One seat per person per Plan, and one Plan per creator idempotency key.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'plan_participants_plan_id_user_id_key') THEN
    RAISE EXCEPTION 'plan_participants uniqueness missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'plans_creator_user_id_idempotency_key_key') THEN
    RAISE EXCEPTION 'plans idempotency uniqueness missing';
  END IF;

  -- Every finite domain the architecture rests on must be unstorable, not
  -- merely unwritten. A missing CHECK here is a Phase-2 bypass waiting to
  -- happen, so this fixture enumerates them one by one.
  FOR needed IN
    SELECT unnest(ARRAY[
      'plans_lifecycle_check',
      'plan_participants_role_check',
      'plan_participants_status_check',
      'plan_items_capability_check',
      'plan_items_status_check',
      'plan_items_details_never_booked_check',
      'plan_items_no_room_no_promise_check'
    ])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = needed) THEN
      RAISE EXCEPTION 'missing structural constraint: %', needed;
    END IF;
  END LOOP;

  IF (SELECT is_nullable FROM information_schema.columns WHERE table_name = 'plans' AND column_name = 'needs') <> 'NO' THEN
    RAISE EXCEPTION 'plans.needs must be NOT NULL to match the Prisma default';
  END IF;

  -- Orphan handling for plan_items must be a trigger, not application-only.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'plan_items_downgrade_orphans') THEN
    RAISE EXCEPTION 'plan_items must downgrade orphans structurally';
  END IF;

  -- Detaching supply must never delete Plan history.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_name = 'plan_items_party_id_fkey' AND delete_rule = 'SET NULL'
  ) THEN
    RAISE EXCEPTION 'plan_items.party_id must be SET NULL on delete';
  END IF;
END $$;
