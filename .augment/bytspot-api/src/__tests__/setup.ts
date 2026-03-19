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
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    venue: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    crowdLevel: {
      findFirst: vi.fn(),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    betaLead: {
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
    frontendUrl: 'http://localhost:3000',
    resendApiKey: '',
    adminPassword: 'test-admin-pass',
    openaiApiKey: '',
    cronSecret: 'test-cron-secret',
    apnsKeyId: '',
    apnsTeamId: '',
    apnsKeyPath: '',
    apnsBundleId: 'com.bytspot.app',
  },
}));

// ── Mock email ────────────────────────────────────────────
vi.mock('../lib/email', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
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

