import { Router } from 'express';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { apnsKeySource, apnsReadiness } from '../services/apns';
import { readPushDeliveryTotals } from '../services/notificationDelivery';
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

  // Push signing is reported because the send path swallows its own failures:
  // an unreadable key looks exactly like a night with nothing to announce.
  // Captured at boot, so a poll neither reads the key nor mints a token.
  checks.push = apnsReadiness();

  // `ready` cannot tell a secret-file mount apart from a relative path that
  // happens to resolve under the current cwd. The second is true until the
  // next build changes what cwd contains, so publishing the shape is what
  // makes "ready today" distinguishable from "ready and durable".
  checks.pushKeySource = apnsKeySource();

  // Signing readiness stops at Apple's door. The tallies say whether anything
  // has ever come out the other side.
  const pushDelivery = await readPushDeliveryTotals();

  // Error tracking is deliberately not part of the healthy test: losing
  // visibility must not take the API out of Render's rotation.
  const healthy = checks.postgres === 'ok';
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'healthy' : 'degraded', version: pkgVersion, checks, pushDelivery });
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
