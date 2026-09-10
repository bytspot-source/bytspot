-- Run only against disposable Postgres with the migration fixture runner.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'deleted_at' AND is_nullable = 'YES'
      AND data_type = 'timestamp without time zone') THEN
    RAISE EXCEPTION 'missing nullable plans.deleted_at tombstone';
  END IF;
END $$;

INSERT INTO users (id, email, password, created_at, updated_at)
VALUES ('plan-delete-fixture-user', 'plan-delete-fixture@example.invalid', 'not-a-login', now(), now());
INSERT INTO plans (id, creator_user_id, idempotency_key, title, intent, join_token, updated_at)
VALUES ('plan-delete-fixture-plan', 'plan-delete-fixture-user', 'plan-delete-fixture-key', 'Fixture', 'Fixture', 'plan-delete-fixture-link', now());
INSERT INTO plan_participants (id, plan_id, user_id, role, status, updated_at)
VALUES ('plan-delete-fixture-seat', 'plan-delete-fixture-plan', 'plan-delete-fixture-user', 'creator', 'accepted', now());
INSERT INTO plan_items (id, plan_id, need_kind, title, updated_at)
VALUES ('plan-delete-fixture-item', 'plan-delete-fixture-plan', 'dining', 'Reference', now());

DO $$ BEGIN
  IF (SELECT deleted_at FROM plans WHERE id = 'plan-delete-fixture-plan') IS NOT NULL THEN
    RAISE EXCEPTION 'existing/default Plan must remain visible';
  END IF;
  UPDATE plans SET deleted_at = now() WHERE id = 'plan-delete-fixture-plan';
  IF EXISTS (SELECT 1 FROM plans WHERE id = 'plan-delete-fixture-plan' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'tombstone still visible';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM plan_items WHERE id = 'plan-delete-fixture-item')
    OR NOT EXISTS (SELECT 1 FROM plan_participants WHERE id = 'plan-delete-fixture-seat') THEN
    RAISE EXCEPTION 'soft deletion removed history';
  END IF;
  BEGIN
    INSERT INTO plans (id, creator_user_id, idempotency_key, title, intent, join_token, updated_at)
    VALUES ('plan-delete-fixture-retry', 'plan-delete-fixture-user', 'plan-delete-fixture-key', 'Retry', 'Retry', 'plan-delete-fixture-link-2', now());
    RAISE EXCEPTION 'deleted create key was reused';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
ROLLBACK;
