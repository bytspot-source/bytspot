-- +goose Up
-- Allow phone-only users and add phone_otp table for OTP auth

-- Make email and password_hash nullable to permit phone-first accounts
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Hashed phone for privacy-preserving contacts match
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users (phone_hash);

-- Unique phone when present
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users (phone) WHERE phone IS NOT NULL;

-- OTP table
CREATE TABLE IF NOT EXISTS phone_otp (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_otp_phone ON phone_otp (phone);
CREATE INDEX IF NOT EXISTS idx_phone_otp_expires_at ON phone_otp (expires_at);

-- +goose Down
-- Revert changes (unsafe if phone-only users exist; for dev only)
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
DROP INDEX IF EXISTS idx_users_phone_hash;
DROP INDEX IF EXISTS uq_users_phone;
DROP INDEX IF EXISTS idx_phone_otp_expires_at;
DROP INDEX IF EXISTS idx_phone_otp_phone;
DROP TABLE IF EXISTS phone_otp;

