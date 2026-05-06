import Redis from 'ioredis';
import { config } from '../config';

/** Singleton Redis client — returns null if REDIS_URL is not configured */
let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (redis) return redis;
  if (!config.redisUrl) {
    console.warn('[redis] REDIS_URL not set — caching disabled');
    return null;
  }
  redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
  });
  redis.on('error', (err) => console.error('[redis] connection error:', err.message));
  redis.on('connect', () => console.log('[redis] connected'));
  redis.connect().catch(() => {});
  return redis;
}

/** Cache helper — get or set with TTL (seconds) */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const r = getRedis();
  if (!r) return fetcher();

  try {
    const hit = await r.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* cache miss or parse error — fall through */
  }

  const data = await fetcher();
  try {
    await r.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  } catch {
    /* write failure is non-fatal */
  }
  return data;
}
