import { z } from 'zod';
import { parseCorsOrigins } from './cors';

const isDev = (process.env.NODE_ENV || 'development') === 'development';

/**
 * Env var schema — parsed and validated at import time.
 *
 * Categories:
 *   CRITICAL  — server MUST NOT start without these in production
 *   IMPORTANT — features degrade without these (push, email, payments)
 *   OPTIONAL  — nice-to-have integrations
 */
const envSchema = z.object({
  // ── CRITICAL ──────────────────────────────────────────
  PORT:           z.string().default('4000'),
  NODE_ENV:       z.string().default('development'),
  DATABASE_URL:   z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET:     z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGINS:   z.string().default('http://localhost:3000'),

  // ── IMPORTANT (degraded features without) ─────────────
  REDIS_URL:              z.string().default(''),
  VAPID_PUBLIC_KEY:       z.string().default(''),
  VAPID_PRIVATE_KEY:      z.string().default(''),
  VAPID_EMAIL:            z.string().default('mailto:bytspotapp@gmail.com'),
  RESEND_API_KEY:         z.string().default(''),
  STRIPE_SECRET_KEY:      z.string().default(''),
  STRIPE_WEBHOOK_SECRET:  z.string().default(''),
  STRIPE_PREMIUM_PRICE_ID:z.string().default(''),
  STRIPE_VENDOR_PREMIUM_PRICE_ID:z.string().default(''),
  STRIPE_VALET_PREMIUM_PRICE_ID:z.string().default(''),
  ADMIN_PASSWORD:         z.string().default(''),
  CRON_SECRET:            z.string().default(isDev ? 'dev-cron-secret' : ''),

  // ── OPTIONAL (integrations) ───────────────────────────
  FRONTEND_URL:           z.string().default('https://beta.bytspot.com'),
  OPENAI_API_KEY:         z.string().default(''),
  TICKETMASTER_API_KEY:   z.string().default(''),
  GOOGLE_PLACES_API_KEY:  z.string().default(''),
  GOOGLE_CLIENT_IDS:      z.string().default(''),
  GOOGLE_CLIENT_ID:       z.string().default(''),
  APNS_KEY_ID:            z.string().default(''),
  APNS_TEAM_ID:           z.string().default(''),
  APNS_KEY_PATH:          z.string().default(''),
  APNS_BUNDLE_ID:         z.string().default('com.bytspot.app'),
});

// In dev mode, allow missing DATABASE_URL and JWT_SECRET with fallbacks
const devOverrides: Partial<Record<string, string>> = isDev
  ? {
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://localhost:5432/bytspot_dev',
      JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me',
    }
  : {};

const parseResult = envSchema.safeParse({ ...process.env, ...devOverrides });

if (!parseResult.success) {
  const formatted = parseResult.error.issues
    .map((i) => `  ❌ ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\n╔══════════════════════════════════════════════╗`);
  console.error(`║  FATAL: Environment variable validation failed  ║`);
  console.error(`╚══════════════════════════════════════════════╝\n`);
  console.error(formatted);
  console.error(`\nSet these in your .env file or Render dashboard.\n`);
  process.exit(1);
}

const env = parseResult.data;

export const config = {
  port: parseInt(env.PORT, 10),
  nodeEnv: env.NODE_ENV,
  isDev,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  corsOrigins: parseCorsOrigins(env.CORS_ORIGINS, env.FRONTEND_URL),
  vapidPublicKey: env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: env.VAPID_PRIVATE_KEY,
  vapidEmail: env.VAPID_EMAIL,
  stripeSecretKey: env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  stripePremiumPriceId: env.STRIPE_PREMIUM_PRICE_ID,
  stripeVendorPremiumPriceId: env.STRIPE_VENDOR_PREMIUM_PRICE_ID,
  stripeValetPremiumPriceId: env.STRIPE_VALET_PREMIUM_PRICE_ID,
  frontendUrl: env.FRONTEND_URL,
  resendApiKey: env.RESEND_API_KEY,
  adminPassword: env.ADMIN_PASSWORD,
  openaiApiKey: env.OPENAI_API_KEY,
  cronSecret: env.CRON_SECRET,
  ticketmasterApiKey: env.TICKETMASTER_API_KEY,
  googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY,
  googleClientIds: [...env.GOOGLE_CLIENT_IDS.split(','), env.GOOGLE_CLIENT_ID].map((id) => id.trim()).filter(Boolean),
  apnsKeyId: env.APNS_KEY_ID,
  apnsTeamId: env.APNS_TEAM_ID,
  apnsKeyPath: env.APNS_KEY_PATH,
  apnsBundleId: env.APNS_BUNDLE_ID,
} as const;

/**
 * Prints a startup diagnostic table showing which optional services are configured.
 * Called from index.ts after server starts listening.
 */
export function printConfigDiagnostics(): void {
  const check = (val: string, label: string, impact: string) =>
    console.log(`   ${val ? '✅' : '⚠️ '} ${label}${val ? '' : ` — ${impact}`}`);

  console.log('   ── Service Configuration ──');
  check(config.vapidPublicKey && config.vapidPrivateKey ? 'ok' : '', 'VAPID keys', 'web push will not work');
  check(config.resendApiKey, 'Resend (email)', 'transactional emails will not send');
  check(config.stripeSecretKey, 'Stripe', 'payments disabled');
  check(config.openaiApiKey, 'OpenAI', 'concierge AI will not work');
  check(config.redisUrl, 'Redis', 'cache, push, and invite storage disabled');
  check(config.cronSecret, 'Cron secret', 'cron endpoints unprotected');
  check(config.ticketmasterApiKey, 'Ticketmaster', 'events feed disabled');
  check(config.googlePlacesApiKey, 'Google Places', 'venue photos unavailable');
  check(config.googleClientIds.length ? 'ok' : '', 'Google Sign-In', 'Google auth disabled');
  check(config.adminPassword, 'Admin password', 'admin dashboard inaccessible');
  console.log('');
}
