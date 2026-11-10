-- REA review 2026-11-10 (C3): consent before concierge requests go to a third-party AI provider.
ALTER TABLE "users" ADD COLUMN "ai_consent_at" TIMESTAMP(3);
