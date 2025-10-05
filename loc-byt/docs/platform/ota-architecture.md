# OTA Architecture Overview

This document unifies Mobile and IoT OTA strategies, services, data flows, and security.

## Components
- Model Orchestrator (Go): manifests, artifacts, cohorts, signing, metrics
- OTA Service (Go): IoT firmware/content, device registry, rollout plans
- Gateway/BFF (Node Fastify): public endpoints, caching, auth
- Flink OTA Monitor (Java): telemetry -> commands
- Storage: GCS (artifacts), Cloud SQL (metadata), Redis (cache), Kafka (events)

## Command & Control
- Admin sets rollout plan -> stored in Cloud SQL -> published to Kafka
- Flink monitors telemetry -> can PAUSE/RESUME rollout via commands
- Gateways cache manifests (ETag) -> clients download from signed URLs

## Security
- KMS-signed artifacts, mTLS for IoT, OIDC for mobile, audit logs

## Rollback
- Mobile: keep prev model; IoT: A/B partitions; server kill switch

