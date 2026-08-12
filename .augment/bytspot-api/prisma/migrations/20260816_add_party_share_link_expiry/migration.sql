-- Host-controlled share-link expiry. Null keeps the default policy: the
-- share link stops resolving when the party ends (ends_at, falling back to
-- starts_at + 6h when no end time was set). Additive and nullable — no
-- rewrite of existing rows.
ALTER TABLE "parties" ADD COLUMN "share_link_expires_at" TIMESTAMP(3);
