-- Official Host identity: public @handle plus an ordered destination list
-- ({ kind, value, primary? }); socials store handles, Bytspot routes them.
ALTER TABLE "host_profiles" ADD COLUMN "handle" TEXT;
ALTER TABLE "host_profiles" ADD COLUMN "host_destinations" JSONB;
CREATE UNIQUE INDEX "host_profiles_handle_key" ON "host_profiles"("handle");
