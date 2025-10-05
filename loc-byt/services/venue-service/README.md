# Venue Service (Go/chi)

Provides venue discovery, details, and likes for beta. OpenAPI-first with oapi-codegen and runtime validation.

## Endpoints
- GET /venues/discover?lat&lon&radius
- GET /venues/{id}
- POST /venues/{id}/like
- GET /healthz, GET /readyz

## Run locally
- `make generate-api`
- `go run ./cmd/venue-service`

## Next
- Add Postgres + PostGIS for real discovery
- Integrate pgvector for recommendations later

