import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as trpcExpress from '@trpc/server/adapters/express';
import { config } from './config';

// tRPC
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';

// REST Routes — only keep endpoints that have no tRPC equivalent or are used externally
import healthRouter from './routes/health';        // external monitoring / Render health checks
import cronRouter from './routes/cron';             // external cron trigger (Bearer token auth)
import pushRouter from './routes/push';             // VAPID public key + subscription endpoint
import betaSignupRouter from './routes/betaSignup'; // bytspot.com funnel (external)
import venuesRouter from './routes/venues';         // SSE stream (venues/crowd/stream) — no tRPC equivalent

import { startCrowdSimulator } from './services/crowdSimulator';

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
app.use(venuesRouter); // kept for SSE /venues/crowd/stream

// ─── 404 catch-all ───────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Startup config validation ───────────────────────
if (!config.isDev) {
  const critical: Array<[string, string]> = [
    [config.jwtSecret, 'JWT_SECRET'],
    [config.databaseUrl, 'DATABASE_URL'],
  ];
  for (const [val, name] of critical) {
    if (!val) {
      console.error(`❌ FATAL: ${name} is not set in production — aborting`);
      process.exit(1);
    }
  }
}

// ─── Start ───────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n🟢 Bytspot API running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Health check: http://localhost:${config.port}/health`);
  console.log(`   VAPID keys: ${config.vapidPublicKey ? '✅ set' : '⚠️  MISSING — web push will not work'}`);
  console.log(`   RESEND_API_KEY: ${config.resendApiKey ? '✅ set' : '❌ MISSING — emails will not send'}`);
  console.log(`   OpenAI: ${config.openaiApiKey ? '✅ set' : '⚠️  MISSING — concierge will not work'}`);
  console.log(`   Stripe: ${config.stripeSecretKey ? '✅ set' : '⚠️  MISSING — payments in demo mode'}\n`);
  // Start in-process crowd simulation (fresh data every 15 min)
  // Crowd alerts are chained — they run automatically after each simulation
  startCrowdSimulator();
});

export default app;
