-- Additive only: no existing business is given a kind, so none is narrowed.
DO $$
DECLARE got integer;
BEGIN
  SELECT count(*) INTO got FROM vendor_sellers WHERE business_kind IS NOT NULL OR cardinality(extra_bookable_types) <> 0;
  IF got <> 0 THEN RAISE EXCEPTION 'the migration assigned a kind to % businesses', got; END IF;
END $$;
