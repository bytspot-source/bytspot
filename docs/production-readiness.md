# Production Readiness Checklist

Security & Privacy
- [ ] Env secrets (no hardcoded secrets); use secret manager in prod
- [ ] CORS allow-list per environment; HTTPS enforced
- [ ] Input validation (BFF + services) for all endpoints
- [ ] Rate limiting (auth, vibe ingest, admin)
- [ ] Vibe HMAC signature + replay protection
- [ ] PII minimization; no sensitive logs
- [ ] Data retention & purge jobs (vibe, presence)
- [ ] Consent flows (location, mic, contacts) with clear copy

Quality & Reliability
- [ ] CI pipelines (lint/type-check/tests/build) passing
- [ ] Unit + integration + smoke tests
- [ ] Error monitoring wired (Sentry/APM)
- [ ] Metrics/Tracing (Prometheus/OpenTelemetry)
- [ ] Health/readiness probes; graceful shutdown

Operations
- [ ] Staging environment with CORS + flags
- [ ] Feature flags; canary/rollback strategy
- [ ] Incident playbooks; on-call notifications
- [ ] Dependency scanning (Dependabot/Renovate); SAST (CodeQL)

Product
- [ ] Phone-first auth flows + email linking
- [ ] Contacts match (privacy-first)
- [ ] Presence + friend notifications (opt-in)
- [ ] Plans (group voting) MVP
- [ ] Smart Parking MVP (search/reserve)
- [ ] Premium/Valet MVP
- [ ] Design system wired (tokens synced)

