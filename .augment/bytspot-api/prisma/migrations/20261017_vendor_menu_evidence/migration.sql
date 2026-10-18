-- Additive: no guessed venue bindings, menu items, or seed inventory.
ALTER TABLE "vendor_locations" ADD COLUMN "menu_venue_id" TEXT;
CREATE UNIQUE INDEX "vendor_locations_menu_venue_id_key" ON "vendor_locations"("menu_venue_id");
ALTER TABLE "vendor_locations" ADD CONSTRAINT "vendor_locations_menu_venue_id_fkey"
  FOREIGN KEY ("menu_venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "vendor_menu_dishes" (
  "id" TEXT PRIMARY KEY,
  "location_id" TEXT NOT NULL REFERENCES "vendor_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "media_id" TEXT NOT NULL REFERENCES "vendor_media"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "dish_name" TEXT NOT NULL,
  "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "review_status" TEXT NOT NULL DEFAULT 'pending',
  "reviewed_at" TIMESTAMP(3), "reviewed_by_user_id" TEXT, "review_note" TEXT,
  "reviewed_venue_id" TEXT, "source_updated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vendor_menu_dishes_status_check" CHECK ("review_status" IN ('pending', 'approved', 'rejected')),
  CONSTRAINT "vendor_menu_dishes_review_shape" CHECK (
    "review_status" <> 'approved' OR ("reviewed_at" IS NOT NULL AND "reviewed_by_user_id" IS NOT NULL
      AND "reviewed_venue_id" IS NOT NULL AND "source_updated_at" IS NOT NULL)),
  CONSTRAINT "vendor_menu_dishes_alias_cap" CHECK (cardinality("aliases") <= 5)
);
CREATE INDEX "vendor_menu_dishes_location_id_idx" ON "vendor_menu_dishes"("location_id");
CREATE INDEX "vendor_menu_dishes_media_id_idx" ON "vendor_menu_dishes"("media_id");
CREATE INDEX "vendor_menu_dishes_review_status_reviewed_at_idx" ON "vendor_menu_dishes"("review_status", "reviewed_at");

CREATE FUNCTION menu_dish_plain_text(value TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND char_length(value) BETWEEN 1 AND 120 AND char_length(btrim(value)) > 0
    AND value !~ '[[:cntrl:]<>@]' AND value !~* '(://|(https?|mailto|tel|data|javascript):|www\.|[[:alnum:]-]+\.[[:alpha:]]{2,}([^[:alnum:]]|$))'
    AND value !~ '([0-9][ .()+-]*){7,}';
$$;

CREATE FUNCTION guard_vendor_menu_dish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loc vendor_locations%ROWTYPE; src vendor_media%ROWTYPE; alias TEXT;
BEGIN
  -- Serializes the per-location cap even for writers outside this API.
  SELECT * INTO loc FROM vendor_locations WHERE id = NEW.location_id FOR UPDATE;
  SELECT * INTO src FROM vendor_media WHERE id = NEW.media_id FOR SHARE;
  IF loc.id IS NULL OR src.id IS NULL OR src.location_id IS DISTINCT FROM loc.id
     OR src.seller_id IS DISTINCT FROM loc.seller_id OR src.bookable_id IS NOT NULL OR src.kind <> 'menu' THEN
    RAISE EXCEPTION 'Invalid menu source scope' USING ERRCODE = '23514';
  END IF;
  IF NOT menu_dish_plain_text(NEW.dish_name) THEN
    RAISE EXCEPTION 'Invalid dish name' USING ERRCODE = '23514';
  END IF;
  FOREACH alias IN ARRAY NEW.aliases LOOP
    IF NOT menu_dish_plain_text(alias) THEN RAISE EXCEPTION 'Invalid dish alias' USING ERRCODE = '23514'; END IF;
  END LOOP;
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM vendor_menu_dishes WHERE location_id = NEW.location_id) >= 100 THEN
      RAISE EXCEPTION 'Menu dish limit reached' USING ERRCODE = '23514';
    END IF;
    NEW.review_status := 'pending';
  ELSE
    IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
      RAISE EXCEPTION 'Menu dish location is immutable' USING ERRCODE = '23514';
    END IF;
    -- Millisecond versions must advance even for two writes in one millisecond.
    NEW.updated_at := GREATEST(NEW.updated_at, OLD.updated_at + interval '1 millisecond');
    IF NEW.dish_name IS DISTINCT FROM OLD.dish_name OR NEW.aliases IS DISTINCT FROM OLD.aliases
       OR NEW.media_id IS DISTINCT FROM OLD.media_id THEN NEW.review_status := 'pending'; END IF;
  END IF;
  IF NEW.review_status = 'pending' THEN
    NEW.reviewed_at := NULL; NEW.reviewed_by_user_id := NULL; NEW.review_note := NULL;
    NEW.reviewed_venue_id := NULL; NEW.source_updated_at := NULL;
  ELSIF NEW.review_status = 'approved' THEN
    IF src.review_status <> 'approved' OR src.byte_size <= 0
       OR NOT (COALESCE(octet_length(src.bytes), 0) > 0 OR COALESCE(length(btrim(src.storage_key)), 0) > 0)
       OR NEW.source_updated_at IS DISTINCT FROM src.updated_at
       OR NEW.reviewed_venue_id IS DISTINCT FROM loc.menu_venue_id
       OR loc.state <> 'ACTIVE'
       OR NOT EXISTS (SELECT 1 FROM vendor_sellers WHERE id = loc.seller_id AND state = 'ACTIVE')
       OR NOT EXISTS (SELECT 1 FROM venues WHERE id = loc.menu_venue_id AND discoverable)
       OR NEW.reviewed_at > clock_timestamp() THEN
      RAISE EXCEPTION 'Menu evidence is not reviewable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_menu_dish_guard BEFORE INSERT OR UPDATE ON vendor_menu_dishes
  FOR EACH ROW EXECUTE FUNCTION guard_vendor_menu_dish();

CREATE FUNCTION invalidate_location_menu_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id AND EXISTS (SELECT 1 FROM vendor_menu_dishes WHERE location_id = OLD.id) THEN
    RAISE EXCEPTION 'Menu location ownership is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.menu_venue_id IS DISTINCT FROM OLD.menu_venue_id THEN
    UPDATE vendor_menu_dishes SET review_status = 'pending', updated_at = clock_timestamp() WHERE location_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_location_menu_invalidation AFTER UPDATE ON vendor_locations
  FOR EACH ROW EXECUTE FUNCTION invalidate_location_menu_evidence();

CREATE FUNCTION guard_menu_media_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'menu' AND OLD.kind <> 'menu' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM vendor_menu_dishes WHERE media_id = OLD.id) THEN
    IF NEW.seller_id IS DISTINCT FROM OLD.seller_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.bookable_id IS DISTINCT FROM OLD.bookable_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'Menu source ownership is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- A bypassing writer cannot replace bytes while preserving approval/version.
  IF NEW.bytes IS DISTINCT FROM OLD.bytes OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size OR NEW.mime_type IS DISTINCT FROM OLD.mime_type THEN
    NEW.review_status := 'pending'; NEW.reviewed_at := NULL; NEW.reviewed_by_user_id := NULL; NEW.review_note := NULL;
  END IF;
  NEW.updated_at := GREATEST(NEW.updated_at, OLD.updated_at + interval '1 millisecond');
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_menu_media_revision BEFORE UPDATE ON vendor_media
  FOR EACH ROW EXECUTE FUNCTION guard_menu_media_revision();

CREATE FUNCTION invalidate_media_menu_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vendor_menu_dishes SET review_status = 'pending', updated_at = clock_timestamp() WHERE media_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_menu_media_invalidation AFTER UPDATE ON vendor_media
  FOR EACH ROW EXECUTE FUNCTION invalidate_media_menu_evidence();
