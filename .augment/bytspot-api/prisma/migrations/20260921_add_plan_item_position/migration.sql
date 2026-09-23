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
-- NULLABLE, and deliberately without a default.
--
-- `migrate deploy` runs from start.sh as the new instance boots, while the
-- previous one is still serving. Anything that instance inserts between this
-- statement and the backfill below is written by code that has never heard of
-- this column. With `NOT NULL DEFAULT 0` those rows would land at position 0
-- and be indistinguishable from a legitimately first item — silent, permanent
-- misordering of a real person's evening, with no constraint to catch it and
-- no way to tell afterwards which rows were affected.
--
-- Nullable makes that same row honest instead: it has no stated position,
-- readers sort it after everything that does have one, and within that group
-- by created_at — which is precisely "appended last", the correct answer. It
-- also makes this migration re-runnable, since the backfill only ever touches
-- rows that have no position yet.
--
-- Positions are per plan, zero-based, and NOT unique: an attach that races
-- another may briefly duplicate one, and a duplicate order is a far smaller
-- harm than a write that fails because two people added to the same Plan at
-- the same moment. Readers break the tie on created_at, then id, so the order
-- is always total and always deterministic.
ALTER TABLE "plan_items" ADD COLUMN "position" INTEGER;

-- Backfill the order these items were attached in, which for existing Plans is
-- the only order anyone has ever seen. Ties inside a single transaction break
-- on id so the result is stable if this is ever re-run.
--
-- Scoped to rows with no position: re-running this cannot renumber an item
-- that has since been positioned, and a row inserted by an old instance after
-- this statement simply keeps its NULL and is appended by readers.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "plan_id" ORDER BY "created_at" ASC, "id" ASC
  ) - 1 AS pos
  FROM "plan_items"
  WHERE "position" IS NULL
)
UPDATE "plan_items"
SET "position" = ordered.pos
FROM ordered
WHERE "plan_items"."id" = ordered.id
  AND "plan_items"."position" IS NULL;

-- The read path is "every item of one plan, in order".
--
-- Not CONCURRENTLY: Prisma wraps each migration in a transaction, which
-- forbids it. This blocks writes to plan_items for the duration of the build,
-- which is acceptable only because the table is small. Revisit before it is
-- not: the replacement is a single-statement migration run outside Prisma.
CREATE INDEX IF NOT EXISTS "plan_items_plan_position_idx"
  ON "plan_items" ("plan_id", "position");
