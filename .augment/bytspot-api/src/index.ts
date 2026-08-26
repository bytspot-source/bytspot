import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as trpcExpress from '@trpc/server/adapters/express';
import { config, printConfigDiagnostics } from './config';
import { captureError, initErrorTracking, installProcessGuards, isErrorTrackingEnabled } from './lib/observability';
import { db } from './lib/db';
import { logAdminBootstrapIds } from './services/adminRbac';

// tRPC
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';

// REST Routes — only keep endpoints that have no tRPC equivalent or are used externally
import healthRouter from './routes/health';        // external monitoring / Render health checks
import cronRouter from './routes/cron';             // external cron trigger (Bearer token auth)
import betaSignupRouter from './routes/betaSignup'; // bytspot.com funnel (external)
import venuesRouter from './routes/venues';         // SSE stream (venues/crowd/stream) — no tRPC equivalent
import partyMediaRouter from './routes/partyMedia';
import partyLandingRouter from './routes/partyLanding'; // server-rendered share-link page (link previews need real HTML)
import diagnosticsRouter from './routes/diagnostics'; // iOS MetricKit crash/hang reports
import partyStripeWebhookRouter from './routes/partyStripeWebhook';

import { startCrowdSimulator } from './services/crowdSimulator';
import { backfillUserIdentityHashes } from './services/userIdentityHashes';
import { captureApnsSigningState } from './services/apns';

// Initialised before the app so instrumentation wraps everything below it.
initErrorTracking();
installProcessGuards();

const app = express();

// Trust Cloudflare → Render LB (2 proxy hops) so express-rate-limit and req.ip see real client IPs
app.set('trust proxy', 2);

// ─── Global Middleware ───────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  }),
);
// Stripe signatures are calculated over the exact raw request body. This route
// must remain before express.json(), which would otherwise consume that body.
app.use(partyStripeWebhookRouter);
app.use(express.json({ limit: '1mb' }));

// Global rate limiting: 300 requests per 15 min per IP
// (tRPC procedures have their own per-endpoint limits for expensive ops)
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  }),
);

// ─── tRPC (primary API layer) ─────────────────────────
app.use(
  '/trpc',
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

// ─── REST Routes (non-duplicated endpoints only) ──────
app.use(healthRouter);
app.use(cronRouter);
app.use(betaSignupRouter);
app.use(venuesRouter); // kept for SSE /venues/crowd/stream
app.use(partyMediaRouter);
app.use(partyLandingRouter);
app.use(diagnosticsRouter);

// ─── 404 catch-all ───────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ───────────────────────────────────
// Express only reaches this with four parameters, and the response body stays
// generic so an internal failure never describes itself to a caller.
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', req.method, req.path, err);
  captureError(err, { route: req.path, method: req.method });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────
// Critical env vars (DATABASE_URL, JWT_SECRET) are validated by Zod in config/index.ts
// — the server won't even reach this point if they're missing in production.
app.listen(config.port, () => {
  console.log(`\n🟢 Bytspot API running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Health check: http://localhost:${config.port}/health`);
  console.log(`   Error tracking: ${isErrorTrackingEnabled() ? 'on' : 'off (SENTRY_DSN unset)'}`);
  // Read the signing key once, here, where a missing mount is visible to
  // whoever is watching the deploy rather than to a poll 50 minutes later.
  // Never fatal: a service that cannot announce must still serve.
  console.log(`   Push signing: ${captureApnsSigningState()}`);
  printConfigDiagnostics();
  // Resolution only — prints ids for ADMIN_BOOTSTRAP_EMAILS, grants nothing.
  void logAdminBootstrapIds((emails) =>
    db.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } }),
  ).catch(() => {});
  // Start in-process crowd simulation (fresh data every 15 min)
  // Crowd alerts are chained — they run automatically after each simulation
  startCrowdSimulator();
  // One-shot, best-effort: hash identifiers for members created before the
  // identity-hash feature so contact discovery covers the full member base.
  void backfillUserIdentityHashes();
});

export default app;
