# Locking the Render origin to Cloudflare (REA X7)

Status: code shipped on branch `fix/abuse-risk-review-2026-11-10`, **off until
configured**. Nothing changes in production until both steps below are done.

## Why
`bytspot-api.onrender.com` answers directly. Express trusts two proxy hops
(`app.set('trust proxy', 2)`), so a caller who skips Cloudflare can send their
own `X-Forwarded-For` and get a fresh per-IP rate-limit bucket on every request.

## What the code does
- `src/middleware/originLock.ts`: when `ORIGIN_LOCK_SECRET` is set, every
  request must carry `x-bytspot-origin-auth: <secret>`, or it gets `403`.
  Exempt: `/health*` (Render health check) and `/webhooks/stripe*` (Stripe
  signs these itself).
- Rate-limit keys use `CF-Connecting-IP` only on requests that carried the
  secret. Everything else keys on `req.ip` as before.

## Daniel: turn it on (order matters)
1. Generate a secret, at least 32 characters, on your own machine, for example
   `openssl rand -base64 48`. Don't paste it into chat or a ticket.
2. Cloudflare → bytspot zone → Rules → Transform Rules → **Modify Request
   Header** → new rule for hostname `api.bytspot.com` (or whatever proxies to
   Render): **Set static** header `x-bytspot-origin-auth` = the secret. Deploy.
3. Render → bytspot-api → Environment: add `ORIGIN_LOCK_SECRET` = the same
   secret, then redeploy.
4. Check:
   - `curl -s -o /dev/null -w '%{http_code}' https://bytspot-api.onrender.com/trpc/health.check` returns `403`
   - `curl -s -o /dev/null -w '%{http_code}' https://api.bytspot.com/trpc/health.check` returns `200`
   - The iOS app and web app still load
5. If the Stripe webhook URL points at the Render hostname, it keeps working (it's
   exempt). It's still better to move it to the Cloudflare hostname.

Rollback: remove `ORIGIN_LOCK_SECRET` in Render and redeploy. The Cloudflare
rule can stay.

To rotate: set the new value in Cloudflare and Render within a few minutes of
each other. Requests fail with 403 during the gap.
