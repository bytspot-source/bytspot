-- Additive only: existing places keep no contact details, existing demand stays broadcast.
DO $$
DECLARE got integer;
BEGIN
  SELECT count(*) INTO got FROM vendor_locations WHERE phone IS NOT NULL OR website IS NOT NULL;
  IF got <> 0 THEN RAISE EXCEPTION 'the migration invented contact details on % places', got; END IF;

  SELECT count(*) INTO got FROM demands WHERE target_window_id IS NOT NULL;
  IF got <> 0 THEN RAISE EXCEPTION 'the migration targeted % existing demands', got; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_locations_phone_shape') THEN
    RAISE EXCEPTION 'vendor_locations_phone_shape is not enforced';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'demands_target_window_id_fkey') THEN
    RAISE EXCEPTION 'demands_target_window_id_fkey is missing';
  END IF;
END $$;
