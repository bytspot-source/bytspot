import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as trpcExpress from '@trpc/server/adapters/express';
import { config, printConfigDiagnostics } from './config';
import { isAllowedCorsOrigin } from './config/cors';

// tRPC
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';

// REST Routes — only keep endpoints that have no tRPC equivalent or are used externally
import healthRouter from './routes/health';        // external monitoring / Render health checks
import cronRouter from './routes/cron';             // external cron trigger (Bearer token auth)
import pushRouter from './routes/push';             // VAPID public key + subscription endpoint
import betaSignupRouter from './routes/betaSignup'; // bytspot.com funnel (external)
import venuesRouter from './routes/venues';         // SSE stream (venues/crowd/stream) — no tRPC equivalent
import auditRouter from './routes/audit';           // /audit/beacon (sendBeacon fallback for client audit sink)
import passwordResetRouter from './routes/passwordReset'; // /auth/forgot + /auth/reset
import stripeWebhookRouter from './routes/stripeWebhook'; // /stripe/webhook (raw body for Stripe signature verification)

import { startCrowdSimulator } from './services/crowdSimulator';

const app = express();

// Trust Cloudflare → Render LB (2 proxy hops) so express-rate-limit and req.ip see real client IPs
app.set('trust proxy', 2);

// ─── Global Middleware ───────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedCorsOrigin(origin, config.corsOrigins)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin ?? 'unknown'} not allowed by CORS`));
    },
    credentials: true,
  }),
);

// Stripe requires the raw request body to verify webhook signatures, so this
// route must be mounted before express.json().
app.use(stripeWebhookRouter);
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
app.use(pushRouter);
app.use(betaSignupRouter);
app.use(passwordResetRouter);
app.use(venuesRouter); // kept for SSE /venues/crowd/stream
app.use(auditRouter);  // /audit/beacon — sendBeacon fallback

// ─── 404 catch-all ───────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Start ───────────────────────────────────────────
// Critical env vars (DATABASE_URL, JWT_SECRET) are validated by Zod in config/index.ts
// — the server won't even reach this point if they're missing in production.
app.listen(config.port, () => {
  console.log(`\n🟢 Bytspot API running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Health check: http://localhost:${config.port}/health`);
  printConfigDiagnostics();
  // Start in-process crowd simulation (fresh data every 15 min)
  // Crowd alerts are chained — they run automatically after each simulation
  startCrowdSimulator();
});

export default app;
