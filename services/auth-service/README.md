# Auth Service (Go/chi)

JWT-based authentication service for beta. OpenAPI-first with oapi-codegen.

## Endpoints
- POST /auth/register
- POST /auth/login
- GET /auth/me
- GET /healthz, GET /readyz

## Run locally
- `make generate-api`
- `go run ./cmd/auth-service`

## Next
- Add Postgres for user storage
- Add password hashing (bcrypt/argon2)
- Add refresh tokens (httpOnly cookie for web)

