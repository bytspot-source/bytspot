# Model Orchestrator (Go/chi)

Manages mobile on-device model artifacts, manifests, signing, and staged rollouts.

## Responsibilities
- Store model versions and metadata
- Generate manifests per platform/arch/cohort
- Serve signed artifacts or deltas (from GCS)
- Collect OTA metrics; expose rollout controls

## Run locally
- `docker compose up` (root) brings deps; run `go run ./cmd/model-orchestrator`

## APIs (draft)
- GET /ml/model/concierge/manifest?platform&arch&app_version
- GET /ml/model/concierge/download?version&delta_from
- POST /ml/metrics
- Admin: POST /ml/rollout, POST /ml/version

## Security
- Sign artifacts via GCP KMS; verify in CI
- Admin endpoints require OIDC + role checks

