-- Recap album publish marker. Null means the host is still staging, which is
-- read as "no recap" by everyone except the host.
ALTER TABLE "parties" ADD COLUMN "recap_published_at" TIMESTAMP(3);
