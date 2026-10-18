-- Disposable migration-fixture database ONLY. These assertions always roll back.
BEGIN;
DO $$
DECLARE v TEXT := 'fixture-menu-venue'; l TEXT := 'fixture-menu-location';
  m TEXT := 'fixture-menu-media'; d TEXT := 'fixture-menu-dish'; version TIMESTAMP(3); got INT; i INT;
BEGIN
  IF EXISTS (SELECT 1 FROM vendor_locations WHERE menu_venue_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM vendor_menu_dishes) THEN RAISE EXCEPTION 'migration invented menu evidence'; END IF;
  INSERT INTO venues (id, name, slug, address, lat, lng, category)
    VALUES (v, 'Fixture Kitchen', v, 'Fixture address', 33.78, -84.38, 'restaurant'),
      (v || '-other', 'Other Kitchen', v || '-other', 'Other address', 33.79, -84.38, 'restaurant');
  INSERT INTO vendor_sellers (id, state, updated_at) VALUES ('fixture-menu-seller', 'ACTIVE', now()), ('fixture-menu-other', 'ACTIVE', now());
  INSERT INTO vendor_locations (id, seller_id, label, kind, state, lat, lng, updated_at, menu_venue_id)
    VALUES (l, 'fixture-menu-seller', 'Fixture', 'fixed', 'ACTIVE', 33.78, -84.38, now(), v),
      (l || '-other', 'fixture-menu-other', 'Other', 'fixed', 'ACTIVE', 33.79, -84.38, now(), NULL),
      (l || '-peer', 'fixture-menu-seller', 'Peer', 'fixed', 'ACTIVE', 33.79, -84.38, now(), NULL);
  INSERT INTO vendor_availability_windows
    (id, seller_id, location_id, sku_template_id, domain, weekdays, open_mins, close_mins, quantity, price_cents, max_guests, updated_at)
    VALUES ('fixture-menu-window', 'fixture-menu-seller', l, 'dining.table-for-4', 'dining', ARRAY[5], 600, 1320, 4, 5000, 4, now());
  INSERT INTO vendor_media (id, seller_id, bookable_id, kind, mime_type, bytes, byte_size, updated_at)
    VALUES (m || '-bookable', 'fixture-menu-seller', 'fixture-menu-window', 'menu', 'application/pdf', decode('0102', 'hex'), 2, now());
  INSERT INTO vendor_media (id, seller_id, location_id, kind, mime_type, bytes, byte_size, updated_at)
    VALUES (m, 'fixture-menu-seller', l, 'menu', 'application/pdf', decode('0102', 'hex'), 2, now()),
      (m || '-other', 'fixture-menu-other', l || '-other', 'menu', 'application/pdf', decode('0102', 'hex'), 2, now()),
      (m || '-photo', 'fixture-menu-seller', l, 'cover', 'image/jpeg', decode('0102', 'hex'), 2, now()),
      (m || '-peer', 'fixture-menu-seller', l || '-peer', 'menu', 'application/pdf', decode('0102', 'hex'), 2, now());
  INSERT INTO vendor_menu_dishes (id, location_id, media_id, dish_name, updated_at)
    VALUES (d, l, m, 'Jollof rice', now());
  IF (SELECT review_status FROM vendor_menu_dishes WHERE id = d) <> 'pending' THEN RAISE EXCEPTION 'not pending'; END IF;

  BEGIN
    INSERT INTO vendor_menu_dishes (id, location_id, media_id, dish_name, updated_at) VALUES (d || '-bad', l, m || '-other', 'Rice', now());
    RAISE EXCEPTION 'cross-seller menu accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO vendor_menu_dishes (id, location_id, media_id, dish_name, updated_at) VALUES (d || '-bad', l, m || '-photo', 'Rice', now());
    RAISE EXCEPTION 'photo accepted as proof';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO vendor_menu_dishes (id, location_id, media_id, dish_name, updated_at) VALUES (d || '-bad', l, m || '-peer', 'Rice', now());
    RAISE EXCEPTION 'other location of same seller accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO vendor_menu_dishes (id, location_id, media_id, dish_name, updated_at) VALUES (d || '-bad', l, m || '-bookable', 'Rice', now());
    RAISE EXCEPTION 'bookable menu accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
      reviewed_venue_id = v, source_updated_at = (SELECT updated_at FROM vendor_media WHERE id = m) WHERE id = d;
    RAISE EXCEPTION 'pending menu approved';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE vendor_media SET review_status = 'approved' WHERE id = m;
  UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
    reviewed_venue_id = v, source_updated_at = (SELECT updated_at FROM vendor_media WHERE id = m) WHERE id = d;
  SELECT updated_at INTO version FROM vendor_menu_dishes WHERE id = d;
  UPDATE vendor_menu_dishes SET aliases = ARRAY['Spiced rice'] WHERE id = d;
  IF (SELECT review_status <> 'pending' OR reviewed_at IS NOT NULL OR source_updated_at IS NOT NULL
      OR updated_at <= version FROM vendor_menu_dishes WHERE id = d) THEN RAISE EXCEPTION 'edit retained review/version'; END IF;
  DELETE FROM vendor_menu_dishes WHERE id = d AND updated_at = version;
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got <> 0 THEN RAISE EXCEPTION 'stale withdrawal succeeded'; END IF;

  UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
    reviewed_venue_id = v, source_updated_at = (SELECT updated_at FROM vendor_media WHERE id = m) WHERE id = d;
  UPDATE vendor_locations SET menu_venue_id = v || '-other' WHERE id = l;
  UPDATE vendor_locations SET menu_venue_id = v WHERE id = l;
  IF (SELECT review_status FROM vendor_menu_dishes WHERE id = d) <> 'pending' THEN RAISE EXCEPTION 'rebind revived review'; END IF;
  BEGIN
    UPDATE vendor_locations SET menu_venue_id = v WHERE id = l || '-other';
    RAISE EXCEPTION 'two locations bound to one venue';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE vendor_media SET seller_id = 'fixture-menu-other' WHERE id = m;
    RAISE EXCEPTION 'source seller changed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE vendor_media SET location_id = l || '-other' WHERE id = m;
    RAISE EXCEPTION 'source location changed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE vendor_locations SET seller_id = 'fixture-menu-other' WHERE id = l;
    RAISE EXCEPTION 'location seller changed';
  EXCEPTION WHEN check_violation THEN NULL; END;

  UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
    reviewed_venue_id = v, source_updated_at = (SELECT updated_at FROM vendor_media WHERE id = m) WHERE id = d;
  SELECT updated_at INTO version FROM vendor_media WHERE id = m;
  UPDATE vendor_media SET bytes = decode('0304', 'hex') WHERE id = m;
  IF (SELECT review_status <> 'pending' OR updated_at <= version FROM vendor_media WHERE id = m)
    OR (SELECT review_status <> 'pending' FROM vendor_menu_dishes WHERE id = d) THEN RAISE EXCEPTION 'replacement retained evidence'; END IF;
  UPDATE vendor_media SET review_status = 'approved' WHERE id = m;
  BEGIN
    UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
      reviewed_venue_id = v, source_updated_at = version WHERE id = d;
    RAISE EXCEPTION 'stale source revision accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  UPDATE venues SET discoverable = false WHERE id = v;
  BEGIN
    UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
      reviewed_venue_id = v, source_updated_at = (SELECT updated_at FROM vendor_media WHERE id = m) WHERE id = d;
    RAISE EXCEPTION 'hidden venue approved';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE venues SET discoverable = true WHERE id = v;
  UPDATE vendor_sellers SET state = 'SUSPENDED' WHERE id = 'fixture-menu-seller';
  BEGIN
    UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
      reviewed_venue_id = v, source_updated_at = (SELECT updated_at FROM vendor_media WHERE id = m) WHERE id = d;
    RAISE EXCEPTION 'suspended seller approved';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE vendor_sellers SET state = 'ACTIVE' WHERE id = 'fixture-menu-seller';
  UPDATE vendor_locations SET state = 'PAUSED' WHERE id = l;
  BEGIN
    UPDATE vendor_menu_dishes SET review_status = 'approved', reviewed_at = now(), reviewed_by_user_id = 'fixture-reviewer',
      reviewed_venue_id = v, source_updated_at = (SELECT updated_at FROM vendor_media WHERE id = m) WHERE id = d;
    RAISE EXCEPTION 'paused location approved';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE vendor_locations SET state = 'ACTIVE' WHERE id = l;

  BEGIN
    UPDATE vendor_menu_dishes SET aliases = ARRAY['a','b','c','d','e','f'] WHERE id = d;
    RAISE EXCEPTION 'alias cap missing';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE vendor_menu_dishes SET dish_name = 'https://example.test' WHERE id = d;
    RAISE EXCEPTION 'URL stored as dish';
  EXCEPTION WHEN check_violation THEN NULL; END;
  FOR i IN 1..99 LOOP
    INSERT INTO vendor_menu_dishes (id, location_id, media_id, dish_name, updated_at) VALUES (d || '-' || i, l, m, 'Rice ' || i, now());
  END LOOP;
  BEGIN
    INSERT INTO vendor_menu_dishes (id, location_id, media_id, dish_name, updated_at) VALUES (d || '-overflow', l, m, 'Overflow', now());
    RAISE EXCEPTION 'location cap missing';
  EXCEPTION WHEN check_violation THEN NULL; END;
  DELETE FROM vendor_media WHERE id = m;
  IF EXISTS (SELECT 1 FROM vendor_menu_dishes WHERE location_id = l) THEN RAISE EXCEPTION 'media deletion did not cascade'; END IF;
END $$;

-- Exercise the same normalized phrase predicate and pre-LIMIT window ordering as the service.
DO $$
DECLARE failures INT; got INT; venues INT; max_dishes INT; far_venues INT;
BEGIN
  WITH cases(query, names, expected) AS (VALUES
    ('chicken rice', ARRAY['Chicken soup with rice noodles'], false),
    ('chicken rice', ARRAY['Rice chicken'], false),
    ('chicken rice', ARRAY['Chicken', 'Rice'], false),
    ('chicken rice', ARRAY['House special', 'Spicy CHICKEN--rice bowl'], true),
    ('rice', ARRAY['Priceless pie'], false),
    ('rice rice', ARRAY['Rice'], false),
    ('rice rice', ARRAY['Rice-rice bowl'], true),
    ('jollof rice', ARRAY['Jollof, rice'], true)
  )
  SELECT count(*) INTO failures FROM cases c WHERE expected IS DISTINCT FROM
    EXISTS (SELECT 1 FROM unnest(c.names) AS names(value)
      WHERE strpos(' ' || btrim(regexp_replace(lower(names.value), '[^[:alnum:]]+', ' ', 'g')) || ' ', ' ' || c.query || ' ') > 0);
  IF failures <> 0 THEN RAISE EXCEPTION 'contiguous whole-token phrase mismatch'; END IF;

  -- Two lexically first venues each have 100 dishes: neither may crowd out nearer venues.
  WITH matched AS (
    SELECT 'venue-' || lpad(v::text, 2, '0') AS id, 'dish-' || lpad(d::text, 3, '0') AS "dishId",
      'Chicken rice ' || d AS "dishName", now() AS "reviewedAt", CASE WHEN v <= 2 THEN 4000 ELSE v END AS distance
    FROM generate_series(1, 25) v CROSS JOIN LATERAL generate_series(1, CASE WHEN v <= 2 THEN 100 ELSE 4 END) d
  ), deduplicated AS (
    SELECT *, row_number() OVER (PARTITION BY id, btrim(regexp_replace(lower("dishName"), '[^[:alnum:]]+', ' ', 'g'))
      ORDER BY "reviewedAt" DESC, "dishId" ASC) AS name_rank FROM matched
  ), ranked AS (
    SELECT *, dense_rank() OVER (ORDER BY distance ASC, id ASC) AS venue_rank,
      row_number() OVER (PARTITION BY id ORDER BY "reviewedAt" DESC, "dishId" ASC) AS dish_rank
    FROM deduplicated WHERE name_rank = 1
  ), bounded AS (
    SELECT * FROM ranked WHERE venue_rank <= 20 AND dish_rank <= 3
    ORDER BY distance ASC, id ASC, "reviewedAt" DESC, "dishId" ASC LIMIT 200
  ), per_venue AS (SELECT id, count(*) AS n FROM bounded GROUP BY id)
  SELECT (SELECT count(*) FROM bounded), count(*), max(n), count(*) FILTER (WHERE id IN ('venue-01', 'venue-02'))
    INTO got, venues, max_dishes, far_venues FROM per_venue;
  IF got <> 60 OR venues <> 20 OR max_dishes <> 3 OR far_venues <> 0 THEN
    RAISE EXCEPTION 'menu evidence venue/dish ranking crowdout';
  END IF;
END $$;
ROLLBACK;
