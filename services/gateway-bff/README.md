# API Gateway / BFF (Node.js Fastify)

Public API surface for mobile/web, proxying to Go services; caches manifests with ETag and enforces auth and rate limits.

## Endpoints (OTA-related)
- GET /ml/model/concierge/manifest
- GET /ml/model/concierge/download
- GET /device/policy
- Admin: rollout management (proxied to model-orchestrator and ota-service)

## Run locally
- `npm i && npm run dev` (see root docker-compose for deps)

## Security
- OIDC JWT validation; Cloud Armor/WAF in prod; ETag caching; Signed URL handling



## API Docs (OpenAPI)

- Landing page: http://localhost:3001/docs (links to Redoc and Swagger UI)

- Live Redoc (served by BFF):
  - BFF Valet: http://localhost:3001/docs/bff-valet (spec at /openapi/bff-valet.yaml)
  - Upstream Valet (reference): http://localhost:3001/docs/upstream-valet (spec at /openapi/upstream-valet.yaml)


- Swagger UI (served by BFF):
  - BFF Valet: http://localhost:3001/swagger/bff-valet
  - Upstream Valet: http://localhost:3001/swagger/upstream-valet

- CI Artifacts:
  - GitHub Actions builds Redoc HTML for both specs and uploads an artifact named `openapi-docs` on each push/PR. Download from the workflow run’s Artifacts section.

- Validation in CI:
  - @redocly/cli lint and swagger-cli validate both YAMLs; PRs will fail if specs break.
