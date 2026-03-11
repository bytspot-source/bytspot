import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';

// Routes
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import venuesRouter from './routes/venues';
import ridesRouter from './routes/rides';
import cronRouter from './routes/cron';
import { startCrowdAlertScheduler } from './services/crowdAlerts';
import pushRouter from './routes/push';
import paymentsRouter from './routes/payments';
import adminRouter from './routes/admin';
import conciergeRouter from './routes/concierge';
import providersRouter from './routes/providers';
import betaSignupRouter from './routes/betaSignup';

const app = express();

// Trust Render's load balancer so express-rate-limit and req.ip work correctly
app.set('trust proxy', 1);

// ─── Global Middleware ───────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

// Rate limiting: 100 requests per 15 min per IP
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  }),
);

// ─── Routes ──────────────────────────────────────────
app.use(healthRouter);
app.use(authRouter);
app.use(venuesRouter);
app.use(ridesRouter);
app.use(cronRouter);
app.use(pushRouter);
app.use(paymentsRouter);
app.use(adminRouter);
app.use(conciergeRouter);
app.use(providersRouter);
app.use(betaSignupRouter);

// ─── 404 catch-all ───────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Start ───────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n🟢 Bytspot API running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Health check: http://localhost:${config.port}/health`);
  console.log(`   RESEND_API_KEY: ${config.resendApiKey ? '✅ set' : '❌ MISSING — emails will not send'}\n`);
  // Start in-process crowd alert scheduler (every 15 min)
  startCrowdAlertScheduler();
});

export default app;
