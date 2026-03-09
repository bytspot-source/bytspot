-- CreateTable: beta_leads
-- Pre-registration email capture from bytspot.com funnel.
-- Separate from users so it works before someone sets a password.

CREATE TABLE "beta_leads" (
  "id"         TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "name"       TEXT,
  "source"     TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "beta_leads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "beta_leads_email_key" ON "beta_leads"("email");

