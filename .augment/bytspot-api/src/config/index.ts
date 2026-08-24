import { z } from 'zod';

const isDev = (process.env.NODE_ENV || 'development') === 'development';

/**
 * Scheduled jobs share this config but not the server's job. The purge cron
 * needs a database and nothing else, so requiring the API's request-signing
 * and contact-hashing secrets there would spread them to a process that never
 * uses them. Job mode drops those requirements; reading one anyway throws
 * rather than quietly signing with an empty secret.
 */
export const isJobRuntime = process.env.BYTSPOT_RUNTIME === 'job';
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Must use HTTPS');

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
  JWT_SECRET:     isJobRuntime ? z.string().default('') : z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGINS:   z.string().default('http://localhost:3000'),

  // ── IMPORTANT (degraded features without) ─────────────
  REDIS_URL:              z.string().default(''),
  SENTRY_DSN:             z.string().default(''),
  RESEND_API_KEY:         z.string().default(''),
  STRIPE_SECRET_KEY:      z.string().default(''),
  STRIPE_WEBHOOK_SECRET:  z.string().default(''),
  STRIPE_PREMIUM_PRICE_ID:z.string().default(''),
  ADMIN_PASSWORD:         z.string().default(''),
  ADMIN_USER_IDS:         z.string().default(''),
  ADMIN_BOOTSTRAP_EMAILS: z.string().default(''),
  CRON_SECRET:            z.string().default(isDev ? 'dev-cron-secret' : ''),

  // ── OPTIONAL (integrations) ───────────────────────────
  FRONTEND_URL:           z.string().default('https://beta.bytspot.com'),
  OPENAI_API_KEY:         z.string().default(''),
  TICKETMASTER_API_KEY:   z.string().default(''),
  GOOGLE_PLACES_API_KEY:  z.string().default(''),
  APNS_KEY_ID:            z.string().default(''),
  APNS_TEAM_ID:           z.string().default(''),
  APNS_KEY_PATH:          z.string().default(''),
  APNS_BUNDLE_ID:         z.string().default('com.bytspot.app'),
  APNS_ENVIRONMENT:       z.enum(['production', 'sandbox']).default('production'),
  APPLE_CLIENT_ID:        z.string().default(''),
  GOOGLE_SERVER_CLIENT_ID:z.string().default(''),
  PUBLIC_API_URL:         httpsUrl.default('https://bytspot-api.onrender.com'),
  PARTY_SHARE_BASE_URL:   httpsUrl.default('https://bytspot.app'),
  MOBILITY_AGGREGATOR_BASE_URL: z.union([z.literal(''), httpsUrl]).default(''),
  MOBILITY_AGGREGATOR_API_KEY: z.string().default(''),
  MOBILITY_AGGREGATOR_MODE: z.enum(['handoff', 'live']).default('handoff'),
  // Shared salt for the privacy-preserving contact graph. MUST match the iOS
  // build's `BytspotContactHashSalt` (Info.plist) or device contact hashes
  // will never match member identity hashes. The dev default is public in
  // this repo, so production refuses to start with it (checked below).
  CONTACT_HASH_SALT:      z.string().default(isDev ? 'dev-contact-salt-change-me' : ''),
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

// The dev salt is public in this repo; running production with it would make
// contact-graph hashes precomputable for common emails. Fail closed instead
// of silently degrading the privacy guarantee.
if (!isDev && !isJobRuntime && env.NODE_ENV !== 'test' && (!env.CONTACT_HASH_SALT || env.CONTACT_HASH_SALT === 'dev-contact-salt-change-me')) {
  console.error('\n❌ FATAL: CONTACT_HASH_SALT must be set to a private value in production (it must match the iOS BytspotContactHashSalt).\n');
  process.exit(1);
}

export const config = {
  port: parseInt(env.PORT, 10),
  nodeEnv: env.NODE_ENV,
  sentryDsn: env.SENTRY_DSN,
  releaseVersion: process.env.RENDER_GIT_COMMIT ?? 'dev',
  isDev,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  get jwtSecret(): string {
    if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not configured in this runtime (job mode does not sign tokens).');
    return env.JWT_SECRET;
  },
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()),
  stripeSecretKey: env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  stripePremiumPriceId: env.STRIPE_PREMIUM_PRICE_ID,
  frontendUrl: env.FRONTEND_URL,
  resendApiKey: env.RESEND_API_KEY,
  adminPassword: env.ADMIN_PASSWORD,
  adminUserIds: env.ADMIN_USER_IDS,
  adminBootstrapEmails: env.ADMIN_BOOTSTRAP_EMAILS,
  openaiApiKey: env.OPENAI_API_KEY,
  cronSecret: env.CRON_SECRET,
  ticketmasterApiKey: env.TICKETMASTER_API_KEY,
  googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY,
  apnsKeyId: env.APNS_KEY_ID,
  apnsTeamId: env.APNS_TEAM_ID,
  apnsKeyPath: env.APNS_KEY_PATH,
  apnsBundleId: env.APNS_BUNDLE_ID,
  apnsEnvironment: env.APNS_ENVIRONMENT,
  appleClientId: env.APPLE_CLIENT_ID,
  googleServerClientId: env.GOOGLE_SERVER_CLIENT_ID,
  publicApiUrl: env.PUBLIC_API_URL.replace(/\/$/, ''),
  partyShareBaseUrl: env.PARTY_SHARE_BASE_URL.replace(/\/$/, ''),
  mobilityAggregatorBaseUrl: env.MOBILITY_AGGREGATOR_BASE_URL.replace(/\/$/, ''),
  mobilityAggregatorApiKey: env.MOBILITY_AGGREGATOR_API_KEY,
  mobilityAggregatorMode: env.MOBILITY_AGGREGATOR_MODE,
  get contactHashSalt(): string {
    if (!env.CONTACT_HASH_SALT) throw new Error('CONTACT_HASH_SALT is not configured in this runtime (job mode does not hash contacts).');
    return env.CONTACT_HASH_SALT;
  },
} as const;

/**
 * Prints a startup diagnostic table showing which optional services are configured.
 * Called from index.ts after server starts listening.
 */
export function printConfigDiagnostics(): void {
  const check = (val: string, label: string, impact: string) =>
    console.log(`   ${val ? '✅' : '⚠️ '} ${label}${val ? '' : ` — ${impact}`}`);

  console.log('   ── Service Configuration ──');
  check(config.resendApiKey, 'Resend (email)', 'transactional emails will not send');
  check(config.stripeSecretKey, 'Stripe', 'payments in demo mode');
  check(config.openaiApiKey, 'OpenAI', 'concierge AI will not work');
  check(config.redisUrl, 'Redis', 'caching disabled, using in-memory fallback');
  check(config.cronSecret, 'Cron secret', 'cron endpoints unprotected');
  check(config.ticketmasterApiKey, 'Ticketmaster', 'events feed will use fallback data');
  check(config.googlePlacesApiKey, 'Google Places', 'venue photos unavailable');
  check(config.mobilityAggregatorMode === 'live' && config.mobilityAggregatorBaseUrl && config.mobilityAggregatorApiKey ? 'ok' : '', 'Mobility aggregator', 'premium rides will use Uber/Lyft handoff only');
  check(config.adminPassword, 'Admin password', 'invite gating disabled — all signups allowed');
  check(config.adminUserIds, 'Admin allowlist', 'no one can reach admin surfaces');
  if (config.adminUserIds.includes('@')) {
    // auth.signup is public and unverified, so an email-keyed allowlist would
    // let anyone register an unclaimed admin address and escalate.
    throw new Error('ADMIN_USER_IDS must contain user ids, not email addresses');
  }
  check(config.apnsKeyId && config.apnsTeamId && config.apnsKeyPath && config.apnsBundleId ? 'ok' : '', 'APNs', 'native push will not send');
  check(config.appleClientId, 'Sign in with Apple', 'native Apple sign-in will not work');
  check(config.googleServerClientId, 'Google Sign-In', 'native Google sign-in will not work');
  console.log('');
}
