-- Adding the Bookable projection is additive: a new table, one new nullable,
-- uniquely-indexed pointer on plan_items, and a cleanup trigger. hostile-shapes
-- seeds no Plans, so this asserts structure and the invariants, not row counts.
DO $$
BEGIN
  -- The projection table exists.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'bookables'
  ) THEN
    RAISE EXCEPTION 'bookables table must exist';
  END IF;

  -- control is never stored: it is derived from capability, so a control column
  -- would let the table contradict the trust gate.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookables' AND column_name = 'control'
  ) THEN
    RAISE EXCEPTION 'bookables must not store control; it is derived from capability';
  END IF;

  -- The pointer exists and stays nullable — no existing plan_item is forced to
  -- carry a handle, and a reference item keeps none.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plan_items' AND column_name = 'bookable_id' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'plan_items.bookable_id must exist and be nullable';
  END IF;

  -- It is uniquely indexed, so a handle names at most one Plan item.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'plan_items_bookable_id_key' AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'plan_items.bookable_id must have a UNIQUE index';
  END IF;

  -- The FK is ON DELETE SET NULL: deleting a handle never deletes its item.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_items_bookable_id_fkey' AND contype = 'f' AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION 'plan_items_bookable_id_fkey must exist and be ON DELETE SET NULL';
  END IF;

  -- The cleanup trigger exists, so a deleted plan_item takes its snapshot with it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'plan_items_delete_bookable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'plan_items_delete_bookable trigger must exist';
  END IF;

  -- The existing single-supply XOR is untouched: the handle is a projection, not
  -- a third supply kind, so it must not appear in that CHECK.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_items_single_supply_check' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'plan_items_single_supply_check must still exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_items_single_supply_check'
      AND pg_get_constraintdef(oid) ILIKE '%bookable_id%'
  ) THEN
    RAISE EXCEPTION 'bookable_id must not participate in the single-supply XOR';
  END IF;
END $$;
