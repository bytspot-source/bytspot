-- Official Host destinations live on the host profile; parties snapshot them at publish.
ALTER TABLE "host_profiles" ADD COLUMN "host_destinations" JSONB;
