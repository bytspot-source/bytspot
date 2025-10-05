-- +goose Up
CREATE TABLE IF NOT EXISTS admin_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID NOT NULL,
    target_email TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('promote','demote')),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit(created_at);

-- +goose Down
DROP INDEX IF EXISTS idx_admin_audit_created_at;
DROP TABLE IF EXISTS admin_audit;

