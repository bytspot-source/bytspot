# Mobile OTA (On-Device Models, Dynamic UI, Policy)

This document defines the Over-The-Air (OTA) update strategy for Bytspot mobile apps, integrating the Mobile BMS, privacy, and hybrid AI.

## Scope
- Edge AI models: Concierge and Vibe (quantized, signed, delta-updatable)
- Remote UI experiments: JSON-driven variations and feature flags
- Policy packs: sampling profiles, geofences, active window caps

## Constraints (Mobile BMS aware)
- Check/apply updates only when:
  - On unmetered Wi‑Fi (or admin-override)
  - Battery ≥ 50% (configurable), not in Low Power Mode, device idle
  - App in foreground or approved background task window (OS constraints)
- Use delta updates (e.g., bsdiff) when possible; verify sha256 and signature

## Flow
1) Client polls GET /ml/model/concierge/manifest with ETag
2) If changed and device passes BMS checks, downloads delta or full
3) Verify signature (GCP KMS key), sha256 integrity
4) Warm swap model; keep previous as rollback
5) POST /ml/metrics with outcome

## Cohorts & A/B
- Cohort assignment: stable hash(anon_user_id, device class, region)
- Rollout: 1% → 10% → 50% → 100% with kill switch
- UI experiments: JSON config with schema validation; rendered dynamically

## Security & Privacy
- No raw audio off-device; features only
- Signed artifacts; manifests must be signed and versioned
- Consent keys included in telemetry; uploads rejected if missing

## Telemetry (summarized)
- device_id (anon), app_version, model_version, event, ts, battery_level, wifi

## Error Handling
- Network: exponential backoff with jitter
- Verification failure: discard artifact, mark cohort bad, backoff
- Apply failure: rollback to last good model, report metrics

## Interfaces
- GET /ml/model/concierge/manifest?platform&arch&app_version
- GET /ml/model/concierge/download?version&delta_from
- POST /ml/metrics


