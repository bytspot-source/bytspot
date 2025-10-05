# Ingestion Service (Go/chi minimal stub)

Purpose: Accept device batch payloads (later via OpenAPI) and forward to Kafka. This stub exposes health endpoints and a placeholder /ingest/batch.

## Run locally
- With docker-compose at repo root: `docker compose up --build`
- Or standalone: `go run ./cmd/ingestion-service`

## Endpoints
- GET /healthz -> 200 ok
- GET /readyz -> 200 ready
- POST /ingest/batch -> 202 (placeholder)

## Next (Step 2: OpenAPI-first)
- Define OpenAPI spec (apis/ingestion.openapi.yaml)
- Generate code with oapi-codegen
- Enforce request/response schema validation

