-- +goose Up
CREATE TABLE IF NOT EXISTS host_onboarding (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    service_type TEXT, -- 'venue' | 'parking' | 'valet'
    data JSONB,
    progress INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION host_onboarding_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_host_onboarding_updated_at ON host_onboarding;
CREATE TRIGGER trg_host_onboarding_updated_at
BEFORE UPDATE ON host_onboarding
FOR EACH ROW
EXECUTE FUNCTION host_onboarding_set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS trg_host_onboarding_updated_at ON host_onboarding;
DROP FUNCTION IF EXISTS host_onboarding_set_updated_at();
DROP TABLE IF EXISTS host_onboarding;

