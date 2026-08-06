-- Curated fan destinations belong to the Host Studio Party and remain an
-- explicit, server-validated public projection rather than untrusted client UI.
ALTER TABLE "parties"
  ADD COLUMN "creator_links" JSONB NOT NULL DEFAULT '[]'::jsonb;