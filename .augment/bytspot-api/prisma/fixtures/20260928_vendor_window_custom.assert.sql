-- Additive only: existing windows keep the catalog's name and length.
DO $$
DECLARE got integer;
BEGIN
  SELECT count(*) INTO got FROM vendor_availability_windows WHERE title IS NOT NULL OR duration_mins IS NOT NULL;
  IF got <> 0 THEN RAISE EXCEPTION 'the migration invented names or lengths on % windows', got; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_windows_custom_named') THEN
    RAISE EXCEPTION 'vendor_windows_custom_named is not enforced';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_windows_duration_range') THEN
    RAISE EXCEPTION 'vendor_windows_duration_range is not enforced';
  END IF;
END $$;
