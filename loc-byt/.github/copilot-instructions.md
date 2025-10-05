# Copilot Instructions for MatchSpot Location Discovery App

## Big Picture Architecture
- **Monorepo** with Go microservices (`services/`), Node.js API Gateway (`services/gateway-bff`), and Expo React Native mobile app (`apps/mobile`).
- **Service boundaries:**
  - `auth-service`: JWT-based authentication, OpenAPI-first, Go/chi.
  - `venue-service`: Venue discovery/details/likes, OpenAPI-first, Go/chi.
  - `ota-service`: IoT device registry, OTA manifest/signage, rollout planning, Go/chi.
  - `ingestion-service`: Device batch ingestion, Kafka forwarding, Go/chi stub.
  - `gateway-bff`: Node.js Fastify, public API, proxies to Go services, handles auth/rate limits.
- **APIs defined in** `apis/*.openapi.yaml`, codegen via `oapi-codegen` for Go services.
- **Mobile app** (`apps/mobile`): Expo/React Native, connects to BFF, stores JWT in `expo-secure-store`.

## Developer Workflows
- **Install dependencies:**
  - Root: `npm i`
  - Mobile: `cd apps/mobile && npm install`
- **Run services locally:**
  - Go services: `go run ./cmd/<service>` (e.g., `go run ./cmd/auth-service`)
  - API Gateway: `npm run dev` in `services/gateway-bff`
  - Mobile: `npm run start` in `apps/mobile`
  - Compose stack: `docker compose up --build` (see root `docker-compose.yml`)
- **Generate Go API code:** `make generate-api` in each Go service
- **Health checks:** All services expose `/healthz` and `/readyz` endpoints

## Project-Specific Conventions
- **OpenAPI-first:** All Go services use OpenAPI specs in `apis/`, codegen with `oapi-codegen`, and runtime validation.
- **JWT Auth:** Mobile and gateway use JWT, stored in secure store on mobile, validated in gateway and Go services.
- **Service communication:** Gateway proxies requests to Go services; admin endpoints may proxy to orchestrator/OTA.
- **Security:** OTA service uses mTLS for devices, signed artifacts, audit logs; gateway enforces OIDC JWT and ETag caching.
- **Mobile config:** BFF URL set in `apps/mobile/app.json` under `extra.BFF_URL`.

## Integration Points & Dependencies
- **Kafka:** Ingestion service forwards device batches to Kafka (future work).
- **GCS:** OTA service integrates with Google Cloud Storage for package store.
- **Postgres:** Venue and Auth services plan to use Postgres (future work).
- **pgvector:** Venue service plans to use pgvector for recommendations.

## Key Files & Directories
- `services/<service>/README.md`: Service-specific run/build instructions
- `apis/*.openapi.yaml`: API definitions for codegen
- `apps/mobile/app.json`: Mobile app config
- `docker-compose.yml`: Multi-service orchestration
- `Makefile`: Codegen/build helpers for Go services

## Example Patterns
- **Add new endpoint:** Update OpenAPI spec, run `make generate-api`, implement handler in Go service.
- **Mobile API call:** Use JWT from secure store, call BFF endpoint, handle errors per screen.
- **Debug service:** Check `/healthz` and `/readyz`, run locally with `go run ./cmd/<service>` or via Docker Compose.

---

For questions or unclear conventions, review the relevant service's README or ask for clarification.
