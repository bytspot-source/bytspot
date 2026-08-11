import { Router } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const webpush = require('web-push');
import { config } from '../config';
import { getRedis } from '../lib/redis';

const router = Router();

// Configure VAPID details once at module load (skip if keys are missing)
if (config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(config.vapidEmail, config.vapidPublicKey, config.vapidPrivateKey);
}

/** In-memory fallback store when Redis is unavailable. Web subscriptions only. */
const memorySubscriptions: string[] = [];

// ─── Web Push (VAPID) helpers ─────────────────────────────────────────────

export async function storeSubscription(sub: object): Promise<void> {
  const json = JSON.stringify(sub);
  const r = getRedis();
  if (r) {
    await r.sadd('push:subscriptions', json).catch(() => {});
  } else {
    if (!memorySubscriptions.includes(json)) memorySubscriptions.push(json);
  }
}

export async function getAllSubscriptions(): Promise<object[]> {
  const r = getRedis();
  if (r) {
    try {
      const members = await r.smembers('push:subscriptions');
      return members.map((m) => JSON.parse(m));
    } catch {
      return [];
    }
  }
  return memorySubscriptions.map((m) => JSON.parse(m));
}


/** GET /push/vapid-public-key — frontend fetches this to subscribe */
router.get('/push/vapid-public-key', (_req, res) => {
  res.json({ key: config.vapidPublicKey });
});

/** POST /push/subscribe — web Push VAPID subscriptions only. */
router.post('/push/subscribe', async (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  if ('nativeToken' in body || 'platform' in body) {
    res.status(403).json({ error: 'Native device registration requires authenticated push.registerIosDevice' });
    return;
  }

  const subscription = body.subscription as { endpoint?: unknown } | undefined;
  try {
    if (subscription && typeof subscription.endpoint === 'string' && subscription.endpoint) {
      await storeSubscription(subscription);
      res.json({ success: true, type: 'web' });
      return;
    }

    res.status(400).json({ error: 'subscription object required' });
  } catch {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

export default router;

