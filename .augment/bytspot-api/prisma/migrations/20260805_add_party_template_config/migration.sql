-- Template behavior is persisted with each Host Studio draft so validation and
-- public presentation never depend on an iOS-only selection.
ALTER TABLE "parties"
  ADD COLUMN "template_config" JSONB NOT NULL DEFAULT '{"kind":"standard"}'::jsonb;