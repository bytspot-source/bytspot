# OTA Service (IoT Signage) - Go/chi

Manages signage firmware/content OTA manifests, device registry, and rollouts.

## Responsibilities
- Device registry (device_id, versions, last_seen, health)
- Package store integration (GCS), signing, manifest generation
- Rollout planning (cohorts, windows), telemetry ingestion

## Run locally
- `docker compose up` then `go run ./cmd/ota-service`

## APIs (draft)
- GET /iot/manifest (device-auth)
- POST /iot/telemetry
- Admin: POST /iot/rollout, GET /iot/devices, POST /iot/package

## Security
- mTLS for devices; signed artifacts; audit logs

