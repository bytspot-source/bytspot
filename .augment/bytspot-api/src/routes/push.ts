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

/** In-memory fallback store when Redis is unavailable */
const memorySubscriptions: string[] = [];
const memoryNativeTokens: string[] = [];

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

// ─── Native Push Token helpers (APNs / FCM) ──────────────────────────────

export async function storeNativeToken(token: string, platform: 'ios' | 'android'): Promise<void> {
  const json = JSON.stringify({ token, platform, registeredAt: new Date().toISOString() });
  const r = getRedis();
  if (r) {
    await r.sadd('push:native_tokens', json).catch(() => {});
  } else {
    if (!memoryNativeTokens.includes(json)) memoryNativeTokens.push(json);
  }
}

export async function getAllNativeTokens(): Promise<Array<{ token: string; platform: string }>> {
  const r = getRedis();
  if (r) {
    try {
      const members = await r.smembers('push:native_tokens');
      return members.map((m) => JSON.parse(m));
    } catch {
      return [];
    }
  }
  return memoryNativeTokens.map((m) => JSON.parse(m));
}

// ─── Unified push sender ─────────────────────────────────────────────────

export async function sendPushToAll(title: string, body: string, data: object = {}): Promise<void> {
  // 1. Web Push (VAPID)
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    const subs = await getAllSubscriptions();
    const payload = JSON.stringify({ title, body, ...data });
    const results = await Promise.allSettled(
      subs.map((sub) => webpush.sendNotification(sub, payload)),
    );
    // Remove expired/unsubscribed web push subscriptions
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

  // 2. Native tokens (APNs/FCM) — placeholder for Phase 2
  // When APNs credentials are configured, send via apple-push-notification-service here.
  // const nativeTokens = await getAllNativeTokens();
  // TODO: Implement APNs HTTP/2 sender when apnsKeyId is configured
}

/** GET /push/vapid-public-key — frontend fetches this to subscribe */
router.get('/push/vapid-public-key', (_req, res) => {
  res.json({ key: config.vapidPublicKey });
});

/** POST /push/subscribe — save a web push subscription OR native device token */
router.post('/push/subscribe', async (req, res) => {
  const { subscription, nativeToken, platform } = req.body as {
    subscription?: { endpoint: string; keys: object };
    nativeToken?: string;
    platform?: 'ios' | 'android';
  };

  try {
    // Native token registration (from Capacitor @capacitor/push-notifications)
    if (nativeToken && platform) {
      await storeNativeToken(nativeToken, platform);
      res.json({ success: true, type: 'native' });
      return;
    }

    // Web Push VAPID subscription
    if (subscription?.endpoint) {
      await storeSubscription(subscription);
      res.json({ success: true, type: 'web' });
      return;
    }

    res.status(400).json({ error: 'subscription object or nativeToken + platform required' });
  } catch {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

export default router;

