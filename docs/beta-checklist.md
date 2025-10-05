# Mobile Beta Ship Checklist

Owner: TBD  |  Target date: TBD

## Builds & Distribution
- [ ] Decide distribution path (EAS recommended) and set EXPO_TOKEN secret in GitHub
- [ ] iOS signing set (Apple Dev), Android keystore managed by EAS or provided
- [ ] EAS preview builds (Android/iOS) succeed
- [ ] Testers added to TestFlight and Play Internal

## Push Notifications
- [ ] APNs key uploaded and configured
- [ ] FCM server key configured
- [ ] In-app opt-in UX verified; at least one push delivered on each platform

## Monitoring & Analytics
- [ ] Sentry DSN set (EXPO_PUBLIC_SENTRY_DSN)
- [ ] Crash reporting events visible in Sentry
- [ ] Minimal analytics events: screen views, explore like/skip, valet intake/complete, payment success/fail

## Permissions & Privacy
- [ ] Location/Notifications rationale copy reviewed
- [ ] iOS Info.plist strings accurate; Android strings localized
- [ ] Contacts flow privacy reviewed; no raw PII upload; deletion path documented

## Config & Flags
- [ ] env per profile (dev/staging/prod): API base URL, sockets, Stripe keys
- [ ] Feature flags default sane; remote flag mechanism tested (optional)

## QA Pass
- [ ] Device matrix: iPhone (A14–A17), Android (Pixel/Samsung mid-tier)
- [ ] E2E flows: Explore → Venue → Valet (intake→status→payment) → push update
- [ ] Performance: map pulses smooth at 100+, no obvious jank; battery sane
- [ ] Crash-free sessions target met (e.g., >99%)

## Store Readiness (for closed beta)
- [ ] App privacy nutrition sheet complete
- [ ] Minimal screenshots/descriptions
- [ ] Release notes for testers

