-- Every business that was already live is stamped; none still setting up is.
DO $$
DECLARE got integer;
BEGIN
  SELECT count(*) INTO got FROM vendor_sellers WHERE state IN ('ACTIVE', 'SUSPENDED') AND verified_at IS NULL;
  IF got <> 0 THEN RAISE EXCEPTION '% live businesses were left unverified', got; END IF;

  SELECT count(*) INTO got FROM vendor_sellers WHERE state IN ('DRAFT', 'PENDING') AND verified_at IS NOT NULL;
  IF got <> 0 THEN RAISE EXCEPTION 'the migration verified % businesses still setting up', got; END IF;
END $$;
