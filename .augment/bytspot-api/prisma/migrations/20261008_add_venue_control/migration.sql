-- A venue is Bytspot-controlled only once the Bytspot team approves it.
-- Every existing venue stays listed until then.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "controlled_at" TIMESTAMP(3);
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "controlled_by_user_id" TEXT;
