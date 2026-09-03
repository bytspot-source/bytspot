-- The Plan control plane is additive: three new tables, nothing altered.
DO $$
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

  -- Detaching supply must never delete Plan history.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_name = 'plan_items_party_id_fkey' AND delete_rule = 'SET NULL'
  ) THEN
    RAISE EXCEPTION 'plan_items.party_id must be SET NULL on delete';
  END IF;
END $$;
