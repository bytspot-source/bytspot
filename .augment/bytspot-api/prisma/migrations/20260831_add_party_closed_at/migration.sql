-- Host-triggered room close. Null means the room is still open in Party
-- Control; a timestamp hides it from the host console without touching
-- `status`, so confirmed guests keep their passes and every existing
-- `status = 'published'` query is unaffected. Additive and nullable.
ALTER TABLE "parties" ADD COLUMN "closed_at" TIMESTAMP(3);
