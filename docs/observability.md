## Bytspot Observability (SRE)

### SLIs/SLOs
- Availability SLI: 1 - (5xx_requests / total_requests)
  - SLO: 99.9% monthly for API; 99.95% target for prod; 99.5% for beta
- Latency SLI: p95 end-to-end request latency (excl. /healthz)
  - SLO: p95 < 300ms (API), p99 < 800ms; dashboard WS msg p95 < 200ms
- Error rate SLI: 5xx ratio over 5m
  - SLO: error_rate < 0.1% (API)
- Saturation SLI: CPU, memory, concurrency utilization < 80% sustained
- WebSocket stability: disconnect rate < 1% over 5m

### Stack
- Metrics: Google Managed Prometheus (scrape/OTel), Cloud Run/SQL native metrics
- Logs: Cloud Logging, Error Reporting
- Tracing: OpenTelemetry SDK -> Cloud Trace
- Dashboards: Grafana (reads Managed Prometheus) + Cloud Monitoring
- Alerts: Cloud Monitoring and/or Grafana Alerting

### Prometheus queries
Latency p95 (HTTP server):
```
histogram_quantile(0.95,
  sum by (le) (rate(http_server_duration_seconds_bucket{job="bytspot-api",route!~"/healthz"}[5m]))
)
```
Error rate (5xx / all):
```
sum(rate(http_requests_total{job="bytspot-api",status=~"5.."}[5m]))
/
sum(rate(http_requests_total{job="bytspot-api"}[5m]))
```
WebSocket disconnect rate:
```
sum(rate(ws_disconnects_total{job="bytspot-api"}[5m]))
/
sum(rate(ws_connections_total{job="bytspot-api"}[5m]))
```

### Grafana alert example (YAML)
```
apiVersion: 1
groups:
  - name: bytspot-api
    interval: 1m
    rules:
      - uid: api-p95-latency
        title: API p95 latency high
        condition: C
        data:
          - refId: A
            datasourceUid: PROM
            queryType: timeSeriesQuery
            relativeTimeRange: {from: 600, to: 0}
            model:
              expr: histogram_quantile(0.95, sum by (le) (rate(http_server_duration_seconds_bucket{job="bytspot-api",route!~"/healthz"}[5m])))
          - refId: B
            datasourceUid: PROM
            queryType: reduce
            model:
              expression: A
              reducer: last
          - refId: C
            datasourceUid: PROM
            queryType: threshold
            model:
              expression: B
              conditions:
                - evaluator: {params: [0.3], type: gt} # 0.3s
                  operator: {type: and}
                  reducer: {type: last}
                  type: query
        for: 5m
        annotations:
          severity: page
          runbook_url: https://runbooks/bytspot/api-500
```

### Incident response strategy
- Detection: Alerts on SLO burn rate, p95 latency, 5xx spike, WS disconnects, DB connection errors
- Triage: Check latest deploy, error logs, recent config/secrets, DB health, quota
- Mitigation:
  - Roll back to last good revision: `gcloud run services update-traffic bytspot-api --to-latest=false --to-revisions REV=100`
  - Scale out: increase max instances; reduce concurrency to lower tail latency
  - DB: failover/fix connections; throttle hot paths; invalidate cache keys if needed
- Comms: User-facing status update for prolonged impact; stakeholder updates
- Postmortem: Blameless analysis, action items with owners/ETAs

