# Flink OTA Telemetry Monitor (Java)

Monitors OTA telemetry streams to enforce safe rollouts.

## Sources
- Kafka topics:
  - mobile_ota_metrics
  - iot_ota_telemetry

## Aggregations
- Sliding windows to compute failure rates per version/cohort
- Alert thresholds to PAUSE rollout via command topic

## Sinks
- Kafka: ota_commands (pause/continue/version_target)
- Redis: live health indicators for dashboards

## State
- RocksDB backend; incremental checkpoints to GCS; savepoints for upgrades


