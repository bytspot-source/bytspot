-- The drifted shape is gone and the contract checks are enforced.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name IN ('demands', 'vendor_availability_windows') AND column_name = 'rail_token') THEN
    RAISE EXCEPTION 'a rail_token column survived the repair';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'demands' AND column_name = 'category') THEN
    RAISE EXCEPTION 'demands.category is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vendor_availability_windows' AND column_name = 'domain') THEN
    RAISE EXCEPTION 'vendor_availability_windows.domain is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'demands_category_known') THEN
    RAISE EXCEPTION 'demands_category_known is not enforced';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_windows_domain_known') THEN
    RAISE EXCEPTION 'vendor_windows_domain_known is not enforced';
  END IF;
END $$;
