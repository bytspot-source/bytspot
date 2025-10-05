-- +goose Up
-- Enable required extensions (safe if already enabled)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    phone TEXT,
    is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    roles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    provider TEXT NOT NULL DEFAULT 'local',
    token_version INT NOT NULL DEFAULT 1,
    metadata JSONB,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure unique, case-insensitive email by lowercasing in app and unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users ((lower(email)));
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
DROP FUNCTION IF EXISTS set_updated_at();
DROP INDEX IF EXISTS idx_users_created_at;
DROP INDEX IF EXISTS uq_users_email;
DROP TABLE IF EXISTS users;

