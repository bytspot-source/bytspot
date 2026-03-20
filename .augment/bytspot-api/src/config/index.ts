const isDev = (process.env.NODE_ENV || 'development') === 'development';

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev,
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  // JWT — MUST be set via env in production
  jwtSecret: process.env.JWT_SECRET || (isDev ? 'dev-secret-change-me' : ''),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim()),
  // VAPID keys — MUST be set via env in production (generate with: npx web-push generate-vapid-keys)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidEmail: process.env.VAPID_EMAIL || 'mailto:bytspotapp@gmail.com',
  // Stripe (set STRIPE_SECRET_KEY in Render env vars)
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  frontendUrl: process.env.FRONTEND_URL || 'https://beta.bytspot.com',
  // Resend transactional email (set RESEND_API_KEY in Render env vars)
  resendApiKey: process.env.RESEND_API_KEY || '',
  // Admin dashboard + invite system (set ADMIN_PASSWORD in Render env vars)
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // OpenAI — used by the Concierge AI chat endpoint (set OPENAI_API_KEY in Render env vars)
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  // Cron secret — protects the /cron/* endpoints from public access (set CRON_SECRET in Render env vars)
  cronSecret: process.env.CRON_SECRET || (isDev ? 'dev-cron-secret' : ''),
  // Ticketmaster Discovery API (set TICKETMASTER_API_KEY in Render env vars)
  ticketmasterApiKey: process.env.TICKETMASTER_API_KEY || '',
  // Google Places API (set GOOGLE_PLACES_API_KEY in Render env vars)
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || '',
  // APNs — Apple Push Notification service for native iOS tokens
  apnsKeyId: process.env.APNS_KEY_ID || '',
  apnsTeamId: process.env.APNS_TEAM_ID || '',
  apnsKeyPath: process.env.APNS_KEY_PATH || '',
  apnsBundleId: process.env.APNS_BUNDLE_ID || 'com.bytspot.app',
} as const;
