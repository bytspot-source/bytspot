/**
 * Vitest global setup — mock external dependencies so tests
 * exercise tRPC procedure logic without touching real DB / Redis / APIs.
 */
import { vi } from 'vitest';

// ── Mock Prisma (db) ──────────────────────────────────────
vi.mock('../lib/db', () => {
  const mockDb: Record<string, any> = {
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    venue: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    hardwarePatch: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    vendor: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    vendorService: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    booking: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    crowdLevel: {
      findFirst: vi.fn(),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    betaLead: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    hostProfile: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    valetProfile: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    checkIn: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'ci-1' }),
      count: vi.fn().mockResolvedValue(0),
    },
    savedSpot: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: 'ss-1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    spotCollection: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'col-1', name: 'Favorites' }),
    },
    spotCollectionItem: {
      upsert: vi.fn().mockResolvedValue({ id: 'sci-1' }),
    },
    pointTransaction: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'pt-1' }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    tip: {
      create: vi.fn().mockResolvedValue({ id: 'tip-1' }),
    },
    userAchievement: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    userPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'up-1' }),
    },
    follow: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'f-1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    complianceLog: {
      create: vi.fn().mockResolvedValue({ id: 'cl-1' }),
    },
    passwordResetToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    revokedPatch: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'rp-1' }),
      count: vi.fn().mockResolvedValue(0),
    },
  };
  return { db: mockDb };
});

// ── Mock Redis ────────────────────────────────────────────
vi.mock('../lib/redis', () => ({
  getRedis: vi.fn().mockReturnValue(null),
  cached: vi.fn().mockImplementation(
    async (_key: string, _ttl: number, fetcher: () => Promise<any>) => fetcher(),
  ),
}));

// ── Mock config ───────────────────────────────────────────
vi.mock('../config', () => ({
  config: {
    port: 4000,
    nodeEnv: 'test',
    isDev: false,
    databaseUrl: '',
    redisUrl: '',
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: '1h',
    corsOrigins: ['http://localhost:3000'],
    vapidPublicKey: 'test-vapid-public',
    vapidPrivateKey: 'test-vapid-private',
    vapidEmail: 'mailto:test@test.com',
    stripeSecretKey: '',
    stripeWebhookSecret: '',
    stripePremiumPriceId: '',
    stripeVendorPremiumPriceId: '',
    stripeValetPremiumPriceId: '',
    frontendUrl: 'http://localhost:3000',
    resendApiKey: '',
    adminPassword: 'test-admin-pass',
    openaiApiKey: '',
    cronSecret: 'test-cron-secret',
    ticketmasterApiKey: '',
    googlePlacesApiKey: '',
    apnsKeyId: '',
    apnsTeamId: '',
    apnsKeyPath: '',
    apnsBundleId: 'com.bytspot.app',
  },
  printConfigDiagnostics: vi.fn(),
}));

// ── Mock email ────────────────────────────────────────────
vi.mock('../lib/email', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendBetaLeadEmail: vi.fn().mockResolvedValue(undefined),
  sendCrowdAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock push ─────────────────────────────────────────────
vi.mock('../routes/push', () => ({
  sendPushToAll: vi.fn().mockResolvedValue(undefined),
  getAllSubscriptions: vi.fn().mockResolvedValue([]),
  getAllNativeTokens: vi.fn().mockResolvedValue([]),
  storeSubscription: vi.fn().mockResolvedValue(undefined),
  storeNativeToken: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock venues (crowdEmitter) ────────────────────────────
vi.mock('../routes/venues', () => {
  const EventEmitter = require('events');
  return { crowdEmitter: new EventEmitter() };
});

// ── Mock crowdAlerts service ──────────────────────────────
vi.mock('../services/crowdAlerts', () => ({
  runCrowdAlerts: vi.fn().mockResolvedValue({ alertsSent: 0 }),
}));

