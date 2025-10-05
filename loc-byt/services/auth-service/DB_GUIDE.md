# Auth Service DB Guide

## Schema Overview (users)
- id: UUID PK (gen_random_uuid())
- email: unique (case-insensitive)
- password_hash: argon2id/bcrypt
- name, phone: optional profile fields
- is_email_verified: boolean
- roles: text[] for simple RBAC (e.g., ["user"], ["admin"]) 
- provider: 'local' or external OIDC provider id
- token_version: rotates on password reset/logout-all
- metadata: jsonb for extensibility
- last_login_at, created_at, updated_at

## Migration Tool
- Using Goose-style annotations for SQL migrations (Up/Down)
- Migrations live in `services/auth-service/migrations`
- Run via container entrypoint or a small Go command in the service

## Next
- Add argon2id password hashing
- Implement CreateUser, GetUserByEmail, VerifyPassword, UpdateLastLogin

