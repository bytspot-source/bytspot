import { Router } from 'express';
import { config } from '../config';
import { runCrowdAlerts } from '../services/crowdAlerts';
import { runCrowdSimulation } from '../services/crowdSimulator';

const router = Router();

/** Verify cron secret from Bearer token */
function verifyCronSecret(req: any): boolean {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === config.cronSecret;
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
  } catch (err: any) {
    console.error('[cron/crowd-alerts] error:', err?.message);
    res.status(500).json({ error: 'Internal error', detail: err?.message });
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
  } catch (err: any) {
    console.error('[cron/crowd-sim] error:', err?.message);
    res.status(500).json({ error: 'Internal error', detail: err?.message });
  }
});

export default router;

