# Bytspot.com marketing site

Public marketing site for [bytspot.com](https://bytspot.com). It is a Vite + React + TypeScript app in this folder, deployed today from the `beta-funnel/deploy` branch as the `bytspot-beta` Render static site.

This is the website, not the iOS app. Party and plan *share links* are still served by the API on bytspot.app; this site explains the product and hosts draft legal shells.

## Run locally

```bash
cd .augment/beta-funnel
npm ci
npm run dev          # http://127.0.0.1:3000
```

```bash
npm run build        # typecheck + production build
npm run preview      # http://127.0.0.1:4173
npm run lint
npm test             # honesty check (no fake scarcity or invented live stats)
```

## Routes

- `/` landing
- `/how-it-works`
- `/host` (and `/party` → `/host`)
- `/invite`
- `/welcome` (legacy email-signup destination; `/#/welcome` still redirects)
- `/legal`, `/terms`, `/privacy`, `/terms-of-sale`, `/host-terms` — draft shells, not in force

The App Store listing is [Bytspot (id 6761876421)](https://apps.apple.com/us/app/bytspot/id6761876421).
