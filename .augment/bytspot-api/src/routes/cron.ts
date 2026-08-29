import { timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { config } from '../config';
import { captureError } from '../lib/observability';
import { runCrowdAlerts } from '../services/crowdAlerts';
import { runCrowdSimulation } from '../services/crowdSimulator';
import { purgeExpiredAccounts } from '../services/accountDeletion';
import { sweepDetachedCheckouts } from '../services/partyCheckoutSettlement';

const router = Router();

/**
 * Verify the cron secret from a Bearer token.
 *
 * An unset secret must reject everything. Comparing against an empty expected
 * value used to accept a request with no Authorization header at all, which
 * left purge-accounts open to anyone whenever CRON_SECRET was missing.
 */
export function verifyCronSecret(req: { headers: Record<string, unknown> }): boolean {
  const expected = config.cronSecret;
  if (!expected) return false;

  const auth = typeof req.headers['authorization'] === 'string' ? (req.headers['authorization'] as string) : '';
  if (!auth.startsWith('Bearer ')) return false;

  const token = Buffer.from(auth.slice(7));
  const secret = Buffer.from(expected);
  if (token.length !== secret.length) return false;
  return timingSafeEqual(token, secret);
}

/**
 * POST /cron/crowd-alerts
 * Manual trigger / external cron endpoint.
 */
router.post('/cron/crowd-alerts', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await runCrowdAlerts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/crowd-alerts] error:', err);
    captureError(err, { job: 'crowd-alerts' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /cron/crowd-sim
 * Trigger crowd simulation manually (generates fresh crowd data for all venues).
 */
router.post('/cron/crowd-sim', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await runCrowdSimulation();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/crowd-sim] error:', err);
    captureError(err, { job: 'crowd-sim' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /cron/purge-accounts
 * Irreversibly removes accounts whose deletion grace period has elapsed.
 */
router.post('/cron/purge-accounts', async (req, res) => {
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await purgeExpiredAccounts();
    // Runs after the purge that creates them: a checkout detached from its
    // party is invisible to every party-scoped settlement path, so this is the
    // only thing that will ever find money still owed on those rows.
    const detached = await sweepDetachedCheckouts();
    res.json({ ok: true, ...result, detached });
  } catch (err) {
    console.error('[cron/purge-accounts] error:', err);
    captureError(err, { job: 'purge-accounts' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;

