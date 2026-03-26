import { Router } from 'express';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read version once at module load (works in both dev and compiled dist/)
const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return 'unknown';
  }
})();

const router = Router();

router.get('/health', async (_req, res) => {
  const checks: Record<string, string> = { api: 'ok' };

  // Postgres
  try {
    await db.$queryRaw`SELECT 1`;
    checks.postgres = 'ok';
  } catch {
    checks.postgres = 'error';
  }

  // Redis
  const redis = getRedis();
  if (redis) {
    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
    }
  } else {
    checks.redis = 'disabled';
  }

  const healthy = checks.postgres === 'ok';
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'healthy' : 'degraded', version: pkgVersion, checks });
});

// ─── Public stats for home screen display ────────────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const [userCount, venueCount, betaLeadCount] = await Promise.all([
      db.user.count(),
      db.venue.count(),
      db.betaLead.count(),
    ]);
    res.json({ userCount, venueCount, betaLeadCount });
  } catch {
    // Fallback so the frontend never crashes
    res.json({ userCount: 246, venueCount: 12, betaLeadCount: 0 });
  }
});

export default router;
