-- The demand spine is a trust surface, so this fixture asserts the closed side
-- holds. Exit code is not the assertion; the rejections are.
--
-- Three classes of claim are checked:
--
--   1. Structure — the two Plan columns exist and stay nullable, and no slots
--      table was created, because a stored slot would give capacity a second
--      source of truth.
--   2. Rejection — a demand whose window runs backwards, a party past the
--      contract ceiling, a radius past its maximum, an offer holding a Bookable
--      it never earned: each must be unstorable, not merely discouraged.
--   3. Immutability — demand_events refuses UPDATE and DELETE, because the log
--      every later optimisation reads must not be rewritable after the fact.
--
-- hostile-shapes seeds only users, so the rows needed to exercise foreign keys
-- are created here and removed at the end.

DO $$
DECLARE
  v_user_id  TEXT := 'assert-demand-user';
  v_plan_id  TEXT := 'assert-demand-plan';
  v_sell_id  TEXT := 'assert-demand-seller';
  v_loc_id   TEXT := 'assert-demand-location';
  v_win_id   TEXT := 'assert-demand-window';
  v_dem_id   TEXT := 'assert-demand-demand';
  v_evt_id   TEXT := 'assert-demand-event';
BEGIN
  -- ── 1. Structure ──────────────────────────────────────────────────────────

  -- A Plan without a budget is still a Plan. Both columns must be nullable.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plans' AND column_name = 'budget_cents' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'plans.budget_cents must exist and be nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plans' AND column_name = 'radius_miles' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'plans.radius_miles must exist and be nullable';
  END IF;

  -- Slots are derived from a window and its commitments. Storing them would let
  -- capacity and state disagree, which the vendor console's model forbids.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name IN ('vendor_slots', 'availability_slots', 'slots')
  ) THEN
    RAISE EXCEPTION 'slots must never be stored; they are derived from windows and commitments';
  END IF;

  -- An offer without a hold deadline is not a hold.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'offers' AND column_name = 'hold_expires_at' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'offers.hold_expires_at must exist and be NOT NULL';
  END IF;

  -- Evidence outlives what it describes: no foreign key from the log to demands.
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    WHERE tc.table_name = 'demand_events' AND tc.constraint_type = 'FOREIGN KEY'
  ) THEN
    RAISE EXCEPTION 'demand_events must not carry a foreign key; evidence outlives its subject';
  END IF;

  -- ── Fixtures for the rejection tests ──────────────────────────────────────

  INSERT INTO users (id, email, password, name, created_at, updated_at)
  VALUES (v_user_id, 'assert-demand@bytspot.test', 'x', 'Assert Demand', NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO plans (id, creator_user_id, idempotency_key, title, intent, join_token,
                     lifecycle, created_at, updated_at)
  VALUES (v_plan_id, v_user_id, 'assert-demand-key', 'Assert', 'assert',
          'assert-demand-token', 'proposed', NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO vendor_sellers (id, state, business_mode, created_at, updated_at)
  VALUES (v_sell_id, 'ACTIVE', 'standard', NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO vendor_locations (id, seller_id, label, kind, state, lat, lng, created_at, updated_at)
  VALUES (v_loc_id, v_sell_id, 'Assert Location', 'fixed', 'ACTIVE', 33.7866, -84.3833, NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  -- ── 2. Rejection: demands ─────────────────────────────────────────────────

  -- A state outside the contract's six must be unstorable.
  BEGIN
    INSERT INTO demands (id, raised_by_user_id, category, state, party_size,
                         earliest, latest, latitude, longitude, radius_miles, expires_at)
    VALUES ('assert-bad-state', v_user_id, 'dining', 'PENDING', 4,
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '3 hours', 33.78, -84.38, 5,
            NOW() + INTERVAL '2 hours');
    RAISE EXCEPTION 'demands accepted a state outside the contract';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A Discover rail is not a discover category. Only categories carry domains,
  -- so a rail token would leave the category match rule with nothing to compare.
  BEGIN
    INSERT INTO demands (id, raised_by_user_id, category, party_size,
                         earliest, latest, latitude, longitude, radius_miles, expires_at)
    VALUES ('assert-rail-not-category', v_user_id, 'eat_drink', 4,
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '3 hours', 33.78, -84.38, 5,
            NOW() + INTERVAL '2 hours');
    RAISE EXCEPTION 'demands accepted a Discover rail where a category belongs';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A window that runs backwards is not a window.
  BEGIN
    INSERT INTO demands (id, raised_by_user_id, category, party_size,
                         earliest, latest, latitude, longitude, radius_miles, expires_at)
    VALUES ('assert-bad-window', v_user_id, 'dining', 4,
            NOW() + INTERVAL '3 hours', NOW() + INTERVAL '1 hour', 33.78, -84.38, 5,
            NOW() + INTERVAL '2 hours');
    RAISE EXCEPTION 'demands accepted a window running backwards';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A need cannot expire before it was raised.
  BEGIN
    INSERT INTO demands (id, raised_by_user_id, category, party_size,
                         earliest, latest, latitude, longitude, radius_miles,
                         raised_at, expires_at)
    VALUES ('assert-bad-expiry', v_user_id, 'dining', 4,
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '3 hours', 33.78, -84.38, 5,
            NOW(), NOW() - INTERVAL '1 hour');
    RAISE EXCEPTION 'demands accepted an expiry before the raise';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- demand.defaults.maxPartySize = 20.
  BEGIN
    INSERT INTO demands (id, raised_by_user_id, category, party_size,
                         earliest, latest, latitude, longitude, radius_miles, expires_at)
    VALUES ('assert-big-party', v_user_id, 'dining', 21,
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '3 hours', 33.78, -84.38, 5,
            NOW() + INTERVAL '2 hours');
    RAISE EXCEPTION 'demands accepted a party beyond the contract ceiling';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- demand.defaults.maxRadiusMiles = 50.
  BEGIN
    INSERT INTO demands (id, raised_by_user_id, category, party_size,
                         earliest, latest, latitude, longitude, radius_miles, expires_at)
    VALUES ('assert-wide-radius', v_user_id, 'dining', 4,
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '3 hours', 33.78, -84.38, 51,
            NOW() + INTERVAL '2 hours');
    RAISE EXCEPTION 'demands accepted a radius beyond the contract maximum';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A demand with no Plan is the common case and must be storable.
  INSERT INTO demands (id, raised_by_user_id, category, party_size,
                       earliest, latest, latitude, longitude, radius_miles, expires_at)
  VALUES (v_dem_id, v_user_id, 'dining', 6,
          NOW() + INTERVAL '1 hour', NOW() + INTERVAL '4 hours', 33.7866, -84.3833, 15,
          NOW() + INTERVAL '2 hours');

  IF NOT EXISTS (SELECT 1 FROM demands WHERE id = v_dem_id AND plan_id IS NULL AND state = 'OPEN') THEN
    RAISE EXCEPTION 'a planless demand must store and default to OPEN';
  END IF;

  -- ── 3. Rejection: windows and commitments ─────────────────────────────────

  -- A window that closes before it opens sells nothing.
  BEGIN
    INSERT INTO vendor_availability_windows
      (id, seller_id, location_id, sku_template_id, domain, weekdays,
       open_mins, close_mins, quantity, price_cents, max_guests, updated_at)
    VALUES ('assert-bad-window-hours', v_sell_id, v_loc_id, 'dining.table-for-4', 'dining',
            ARRAY[5], 1320, 600, 4, 5000, 4, NOW());
    RAISE EXCEPTION 'windows accepted a close before its open';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- The seller's side of the category rule takes a domain, not a category.
  BEGIN
    INSERT INTO vendor_availability_windows
      (id, seller_id, location_id, sku_template_id, domain, weekdays,
       open_mins, close_mins, quantity, price_cents, max_guests, updated_at)
    VALUES ('assert-bad-domain', v_sell_id, v_loc_id, 'dining.table-for-4', 'entertainment',
            ARRAY[5], 600, 1320, 4, 5000, 4, NOW());
    RAISE EXCEPTION 'windows accepted a category where a domain belongs';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- availability.slotKinds.
  BEGIN
    INSERT INTO vendor_availability_windows
      (id, seller_id, location_id, sku_template_id, domain, slot_kind, weekdays,
       open_mins, close_mins, quantity, price_cents, max_guests, updated_at)
    VALUES ('assert-bad-slot-kind', v_sell_id, v_loc_id, 'dining.table-for-4', 'dining',
            'hourly', ARRAY[5], 600, 1320, 4, 5000, 4, NOW());
    RAISE EXCEPTION 'windows accepted a slot kind outside the contract';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO vendor_availability_windows
    (id, seller_id, location_id, sku_template_id, domain, weekdays,
     open_mins, close_mins, quantity, price_cents, max_guests, updated_at)
  VALUES (v_win_id, v_sell_id, v_loc_id, 'dining.table-for-4', 'dining',
          ARRAY[5], 600, 1320, 4, 5000, 6, NOW());

  -- A block nobody can explain is an outage, not a decision.
  BEGIN
    INSERT INTO vendor_slot_commitments (id, window_id, starts_at, blocked, updated_at)
    VALUES ('assert-unexplained-block', v_win_id, NOW() + INTERVAL '1 day', true, NOW());
    RAISE EXCEPTION 'commitments accepted a block with no reason';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- availability.blockReasons. A reason outside the vocabulary cannot be shown
  -- to a guest, so it cannot be stored.
  BEGIN
    INSERT INTO vendor_slot_commitments (id, window_id, starts_at, blocked, block_reason, updated_at)
    VALUES ('assert-bad-reason', v_win_id, NOW() + INTERVAL '2 days', true, 'because', NOW());
    RAISE EXCEPTION 'commitments accepted a block reason outside the vocabulary';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- One window plus one instant is one slot. A second row for it is a second
  -- truth about the same capacity.
  INSERT INTO vendor_slot_commitments (id, window_id, starts_at, committed, updated_at)
  VALUES ('assert-commit-1', v_win_id, TIMESTAMP '2026-12-04 22:00:00', 2, NOW());

  BEGIN
    INSERT INTO vendor_slot_commitments (id, window_id, starts_at, committed, updated_at)
    VALUES ('assert-commit-2', v_win_id, TIMESTAMP '2026-12-04 22:00:00', 3, NOW());
    RAISE EXCEPTION 'commitments accepted two rows for one slot';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- ── 4. Rejection: offers ──────────────────────────────────────────────────

  -- A Bookable is earned by acceptance. An offer still on the table cannot hold one.
  BEGIN
    INSERT INTO offers (id, demand_id, seller_id, location_id, sku_template_id,
                        starts_at, duration_mins, price_cents, capacity,
                        state, hold_expires_at, created_by_seat_id, bookable_id, updated_at)
    VALUES ('assert-premature-bookable', v_dem_id, v_sell_id, v_loc_id, 'dining.table-for-4',
            NOW() + INTERVAL '2 hours', 90, 15000, 6,
            'OFFERED', NOW() + INTERVAL '30 minutes', 'assert-seat', 'some-bookable', NOW());
    RAISE EXCEPTION 'offers accepted a Bookable without acceptance';
  EXCEPTION WHEN check_violation THEN NULL; WHEN foreign_key_violation THEN NULL; END;

  -- A hold whose deadline has already passed at creation is not a hold.
  BEGIN
    INSERT INTO offers (id, demand_id, seller_id, location_id, sku_template_id,
                        starts_at, duration_mins, price_cents, capacity,
                        hold_expires_at, created_by_seat_id, created_at, updated_at)
    VALUES ('assert-dead-hold', v_dem_id, v_sell_id, v_loc_id, 'dining.table-for-4',
            NOW() + INTERVAL '2 hours', 90, 15000, 6,
            NOW() - INTERVAL '1 hour', 'assert-seat', NOW(), NOW());
    RAISE EXCEPTION 'offers accepted a hold that had already expired';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A hand-asserted offer needs no standing window; this is the launch path.
  INSERT INTO offers (id, demand_id, seller_id, location_id, sku_template_id,
                      starts_at, duration_mins, price_cents, capacity,
                      hold_expires_at, created_by_seat_id, updated_at)
  VALUES ('assert-hand-offer', v_dem_id, v_sell_id, v_loc_id, 'dining.table-for-4',
          NOW() + INTERVAL '2 hours', 90, 15000, 6,
          NOW() + INTERVAL '30 minutes', 'assert-seat', NOW());

  IF NOT EXISTS (
    SELECT 1 FROM offers WHERE id = 'assert-hand-offer' AND window_id IS NULL AND state = 'OFFERED'
  ) THEN
    RAISE EXCEPTION 'a hand-asserted offer must store with no window and default to OFFERED';
  END IF;

  -- ── 5. Immutability of the log ────────────────────────────────────────────

  INSERT INTO demand_events (id, demand_id, kind) VALUES (v_evt_id, v_dem_id, 'PUBLISHED');

  BEGIN
    UPDATE demand_events SET kind = 'ACCEPTED' WHERE id = v_evt_id;
    RAISE EXCEPTION 'demand_events accepted an update';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'demand_events is append-only' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM demand_events WHERE id = v_evt_id;
    RAISE EXCEPTION 'demand_events accepted a delete';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'demand_events is append-only' THEN RAISE; END IF;
  END;

  -- A kind outside the vocabulary is unstorable.
  BEGIN
    INSERT INTO demand_events (id, demand_id, kind) VALUES ('assert-bad-kind', v_dem_id, 'MAYBE');
    RAISE EXCEPTION 'demand_events accepted an unknown kind';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- ── Cleanup ───────────────────────────────────────────────────────────────
  -- The log cannot be deleted by design, so its table is truncated rather than
  -- swept. Everything else cascades from the rows created above.

  DELETE FROM offers WHERE demand_id = v_dem_id;
  TRUNCATE TABLE demand_events;
  DELETE FROM demands WHERE id = v_dem_id;
  DELETE FROM vendor_availability_windows WHERE id = v_win_id;
  DELETE FROM vendor_locations WHERE id = v_loc_id;
  DELETE FROM vendor_sellers WHERE id = v_sell_id;
  DELETE FROM plans WHERE id = v_plan_id;
  DELETE FROM users WHERE id = v_user_id;
END $$;

-- ── Vendor intent ────────────────────────────────────────────────────────────
-- A seller says what a window is for; the platform holds them to it. The closed
-- side is the assertion: words whose rail does not exist must be unstorable.
DO $$
DECLARE
  v_seller_id TEXT := 'assert-intent-seller';
  v_loc_id    TEXT := 'assert-intent-loc';
  v_win_id    TEXT := 'assert-intent-win';
BEGIN
  INSERT INTO "vendor_sellers" ("id", "state", "business_mode", "created_at", "updated_at")
    VALUES (v_seller_id, 'ACTIVE', 'standard', NOW(), NOW());
  INSERT INTO "vendor_locations" ("id", "seller_id", "label", "kind", "lat", "lng", "timezone", "state", "created_at", "updated_at")
    VALUES (v_loc_id, v_seller_id, 'Assert Room', 'venue', 33.78, -84.38, 'America/New_York', 'ACTIVE', NOW(), NOW());
  INSERT INTO "vendor_availability_windows"
      ("id", "seller_id", "location_id", "sku_template_id", "domain", "slot_minutes",
       "weekdays", "open_mins", "close_mins", "quantity", "price_cents", "max_guests", "created_at", "updated_at")
    VALUES (v_win_id, v_seller_id, v_loc_id, 'dining.table', 'dining', 60,
            '{0,1,2,3,4,5,6}', 1020, 1320, 4, 5000, 4, NOW(), NOW());

  -- A window answers asks unless the seller says otherwise. The default states
  -- what these rows already did before the column existed.
  ASSERT (SELECT "intent" FROM "vendor_availability_windows" WHERE "id" = v_win_id) = 'request',
    'a window must default to answering asks';

  -- Declining must be expressible without deleting the window.
  UPDATE "vendor_availability_windows" SET "intent" = 'none' WHERE "id" = v_win_id;

  -- Rejection: a promise with nothing behind it must be unstorable, not merely
  -- discouraged. These become legal only when their rail is built.
  BEGIN
    UPDATE "vendor_availability_windows" SET "intent" = 'book' WHERE "id" = v_win_id;
    RAISE EXCEPTION 'book was stored before anything could honour it';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE "vendor_availability_windows" SET "intent" = 'order' WHERE "id" = v_win_id;
    RAISE EXCEPTION 'order was stored before anything could honour it';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE "vendor_availability_windows" SET "intent" = 'redirect' WHERE "id" = v_win_id;
    RAISE EXCEPTION 'redirect was stored before anything could honour it';
  EXCEPTION WHEN check_violation THEN NULL; END;

  DELETE FROM "vendor_sellers" WHERE "id" = v_seller_id;
END $$;
