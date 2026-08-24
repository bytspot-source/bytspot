import { Router } from 'express';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { isErrorTrackingEnabled } from '../lib/observability';
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

  // On/off only: whether errors are being reported is operational state, the
  // DSN itself is not.
  checks.errorTracking = isErrorTrackingEnabled() ? 'on' : 'off';

  // Error tracking is deliberately not part of the healthy test: losing
  // visibility must not take the API out of Render's rotation.
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
    // A count we cannot read is unknown, not 246. Inventing one here would
    // publish a number precisely when nothing can verify it.
    res.status(503).json({ error: 'Counts unavailable' });
  }
});

export default router;
