import { Router } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const webpush = require('web-push');
import { config } from '../config';
import { getRedis } from '../lib/redis';

const router = Router();

// Configure VAPID details once at module load
webpush.setVapidDetails(config.vapidEmail, config.vapidPublicKey, config.vapidPrivateKey);

/** In-memory fallback store when Redis is unavailable */
const memorySubscriptions: string[] = [];

export async function storeSubscription(sub: object): Promise<void> {
  const json = JSON.stringify(sub);
  const r = getRedis();
  if (r) {
    // Store each subscription as a member of a Redis set
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

export async function sendPushToAll(title: string, body: string, data: object = {}): Promise<void> {
  const subs = await getAllSubscriptions();
  const payload = JSON.stringify({ title, body, ...data });
  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload)),
  );
  // Remove subscriptions that are no longer valid (expired/unsubscribed)
  const r = getRedis();
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const expired = result.reason?.statusCode === 410 || result.reason?.statusCode === 404;
      if (expired) {
        const json = JSON.stringify(subs[i]);
        if (r) r.srem('push:subscriptions', json).catch(() => {});
        else {
          const idx = memorySubscriptions.indexOf(json);
          if (idx >= 0) memorySubscriptions.splice(idx, 1);
        }
      }
    }
  });
}

/** GET /push/vapid-public-key — frontend fetches this to subscribe */
router.get('/push/vapid-public-key', (_req, res) => {
  res.json({ key: config.vapidPublicKey });
});

/** POST /push/subscribe — save a push subscription */
router.post('/push/subscribe', async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub || !sub.endpoint) {
    res.status(400).json({ error: 'subscription object required' });
    return;
  }
  try {
    await storeSubscription(sub);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

export default router;

