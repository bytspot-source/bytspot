import { Router } from 'express';
import { config } from '../config';
import { runCrowdAlerts } from '../services/crowdAlerts';

const router = Router();

/**
 * POST /cron/crowd-alerts
 *
 * Manual trigger / external cron endpoint.
 * Protected by Bearer token matching CRON_SECRET env var.
 * The in-process scheduler in index.ts calls runCrowdAlerts() directly.
 */
router.post('/cron/crowd-alerts', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== config.cronSecret) {
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

export default router;

