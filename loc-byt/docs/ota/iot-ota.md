# IoT OTA (Signage Firmware, Content, Configuration)

Defines OTA strategy for connected Bytspot signage devices.

## Scope
- Firmware updates (A/B partition, signed)
- Content bundles (images/video/templates) delivered by vibe context
- Configuration & calibration (sensors, brightness, network)

## Security
- mTLS device auth; device certificates provisioned at onboarding
- Signed firmware/content manifests; sha256 integrity
- Bootloader verifies signature before boot; fallback to previous slot on failure

## Rollout
- Cohorts by region/venue/model; scheduled off-peak windows
- Staged rollout with health gates (telemetry-driven)
- Kill switch & rollback

## Flow
1) Device polls GET /iot/manifest (or receives push) with current versions
2) Service returns new firmware/content URLs (signed) if available
3) Device downloads to inactive slot/storage, verifies, swaps, reboots if firmware
4) Device posts telemetry status; Flink monitors fleet health

## Telemetry
- device_id, current_firmware, boot_slot, last_update_status, last_boot_ok, temp, signal, ts

## Interfaces
- GET /iot/manifest (device-authenticated)
- POST /iot/telemetry
- Admin: POST /iot/rollout, GET /iot/devices, POST /iot/package


