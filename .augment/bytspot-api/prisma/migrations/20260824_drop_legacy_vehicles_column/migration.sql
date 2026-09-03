-- 20260824_add_vehicle_table copied every legacy row into the vehicles table
-- and the four procedures have read that table exclusively for a deploy. This
-- column is the last thing that could still serve a stale answer, so it goes.
--
-- Irreversible on purpose: the backfill has already run, so re-running it after
-- this point would have nothing to read. Recovery is a database restore, not a
-- down migration, which is why the drop waited for a deploy instead of riding
-- along with the migration that created the table.
ALTER TABLE "users" DROP COLUMN "vehicles";
