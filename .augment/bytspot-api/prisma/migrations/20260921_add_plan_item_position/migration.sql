-- An explicit order for the items in a Plan.
--
-- A Plan is a sequence — coffee, then a table, then a room — but nothing
-- recorded that sequence. Items were read back `orderBy createdAt`, which is
-- the order they were attached, not the order they will be lived. Two items
-- attached in one transaction can also share a timestamp, leaving their order
-- decided by nothing at all.
--
-- The feasibility solver cannot ask "does this sequence fit in the window"
-- until there is a sequence to ask about, so the order stops being an accident
-- of insertion and becomes a stored fact.
--
-- NOT NULL with a default, because every item has a place in the list; there
-- is no such thing as an item with an unknown position. Positions are per
-- plan, zero-based, and deliberately NOT unique: an attach that races another
-- may briefly duplicate a position, and a duplicate order is a far smaller
-- harm than a write that fails because two people added to the same Plan at
-- the same moment. Readers break the tie on created_at, then id, so the order
-- is always total and always deterministic.
ALTER TABLE "plan_items" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Backfill the order these items were attached in, which for existing Plans is
-- the only order anyone has ever seen. Ties inside a single transaction break
-- on id so the result is stable if this is ever re-run.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "plan_id" ORDER BY "created_at" ASC, "id" ASC
  ) - 1 AS pos
  FROM "plan_items"
)
UPDATE "plan_items"
SET "position" = ordered.pos
FROM ordered
WHERE "plan_items"."id" = ordered.id;

-- The read path is "every item of one plan, in order".
CREATE INDEX IF NOT EXISTS "plan_items_plan_position_idx"
  ON "plan_items" ("plan_id", "position");
