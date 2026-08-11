-- Legacy deployments kept this pre-Prisma field as NOT NULL. The current
-- Party model does not write it, so allow new Party drafts while preserving
-- all existing legacy values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'parties'
      AND column_name = 'draft_fingerprint'
  ) THEN
    ALTER TABLE "parties" ALTER COLUMN "draft_fingerprint" DROP NOT NULL;
  END IF;
END $$;