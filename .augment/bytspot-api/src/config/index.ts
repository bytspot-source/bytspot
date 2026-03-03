export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim()),
  // VAPID keys for Web Push notifications (set in Render env vars)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || 'BPAk0Yj7SpmcG1HyFD_HUIccIfTmWqy-41IsRFwQHHCvaczSZf00sHkqs0n4jO9lbGZbkQO3zDZbqc_42TLJh9w',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || 'nxBAych-BWa_WxMMAcd3-G5pFoZGH13GOoY43Xk1OVE',
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
} as const;
