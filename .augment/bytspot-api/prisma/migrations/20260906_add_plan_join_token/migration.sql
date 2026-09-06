-- A Plan join token is a bearer secret carried in the invite link, distinct
-- from the guessable id: the id previews a Plan, the token grants a seat.
-- Added nullable, backfilled, then made NOT NULL + UNIQUE so the change is safe
-- on a table that already holds Plans. gen_random_uuid() is core in PG13+.
ALTER TABLE "plans" ADD COLUMN "join_token" TEXT;
UPDATE "plans" SET "join_token" = gen_random_uuid()::text WHERE "join_token" IS NULL;
ALTER TABLE "plans" ALTER COLUMN "join_token" SET NOT NULL;
CREATE UNIQUE INDEX "plans_join_token_key" ON "plans"("join_token");
