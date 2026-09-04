import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { getRedis } from '../lib/redis';
import { captureError } from '../lib/observability';

const placesPhotoRouter = Router();

const GP_BASE = 'https://places.googleapis.com/v1';

/**
 * Google's photo resource name, and nothing else. The name is interpolated
 * into an outbound URL, so anything looser is a server-side request forgery
 * against Google's API surface with our credential attached.
 */
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]{1,256}\/photos\/[A-Za-z0-9_-]{1,1024}$/;

const MIN_WIDTH = 100;
const MAX_WIDTH = 1600;
const DEFAULT_WIDTH = 800;

/**
 * Google documents the signed photoUri only as "short-lived" with no stated
 * duration, so this stays well inside any plausible one. Serving a cached
 * redirect past its expiry shows a broken image.
 */
const RESOLVED_TTL_SECONDS = 120;

/** A rejected upstream answer is remembered briefly so a hot bad name cannot
 * be replayed into an unbounded number of billed Google requests. */
const NEGATIVE_TTL_SECONDS = 60;
const NEGATIVE_SENTINEL = '\u0000miss';

/**
 * Widths collapse into buckets. An attacker varying w by one pixel would
 * otherwise mint unlimited distinct cache keys, and each miss is a billed
 * Google Photo Media request.
 */
const WIDTH_BUCKETS = [200, 400, 800, 1600];

/**
 * The only hosts this endpoint will redirect to. Google's photoUri is a
 * keyless googleusercontent URL today; if the upstream ever returned
 * something else, an unvalidated 302 would make this an open redirect.
 */
const ALLOWED_REDIRECT_HOSTS = /(^|\.)googleusercontent\.com$/;

export function isPhotoName(name: unknown): name is string {
  return typeof name === 'string' && PHOTO_NAME.test(name);
}

export function clampWidth(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_WIDTH;
  const bounded = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(parsed)));
  return WIDTH_BUCKETS.find((bucket) => bounded <= bucket) ?? MAX_WIDTH;
}

export function isAllowedRedirect(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The URL handed to clients. It points at this server, not at Google, because
 * Google's media endpoint only accepts the API key as a query parameter — so
 * any URL a client could fetch directly would carry the key with it.
 */
export function photoProxyUrl(photoName: string, width = DEFAULT_WIDTH): string {
  return `${config.publicApiUrl}/places/photo?name=${encodeURIComponent(photoName)}&w=${clampWidth(width)}`;
}

async function resolvePhotoUri(photoName: string, width: number): Promise<string | null> {
  const cacheKey = `gp:photo:${photoName}:${width}`;
  const redis = getRedis();
  if (redis) {
    const hit = await Promise.resolve(redis.get(cacheKey)).catch(() => null);
    if (hit === NEGATIVE_SENTINEL) return null;
    if (hit) return hit;
  }

  const remember = async (value: string, ttl: number) => {
    if (!redis) return;
    await Promise.resolve(redis.set(cacheKey, value, 'EX', ttl)).catch(() => undefined);
  };

  // skipHttpRedirect returns the signed URI as JSON instead of a 302, so the
  // key stays in this process and only the keyless URI is ever forwarded.
  const url = `${GP_BASE}/${photoName}/media?maxWidthPx=${width}&skipHttpRedirect=true`;
  const response = await fetch(url, {
    headers: { 'X-Goog-Api-Key': config.googlePlacesApiKey },
    signal: AbortSignal.timeout(8000),
  });

  // A well-formed name Google rejects is remembered briefly: without this,
  // one name replayed in a loop is unlimited billed requests.
  if (response.status >= 400 && response.status < 500) {
    await remember(NEGATIVE_SENTINEL, NEGATIVE_TTL_SECONDS);
    return null;
  }
  if (!response.ok) throw new Error(`google places photo ${response.status}`);

  const body = (await response.json()) as { photoUri?: unknown };
  const photoUri = typeof body.photoUri === 'string' ? body.photoUri : null;
  if (!photoUri || !isAllowedRedirect(photoUri)) {
    await remember(NEGATIVE_SENTINEL, NEGATIVE_TTL_SECONDS);
    return null;
  }

  await remember(photoUri, RESOLVED_TTL_SECONDS);
  return photoUri;
}

/**
 * Tighter than the global limit because every miss is a billed Google Photo
 * Media request, and the endpoint is necessarily unauthenticated: image
 * loaders send no credentials.
 */
const photoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many photo requests' },
});

placesPhotoRouter.get('/places/photo', photoLimiter, async (req, res) => {
  const { name } = req.query;
  if (!isPhotoName(name)) return res.status(400).json({ error: 'Invalid photo name' });
  if (!config.googlePlacesApiKey) return res.status(404).json({ error: 'Not found' });

  const width = clampWidth(req.query.w);
  try {
    const photoUri = await resolvePhotoUri(name, width);
    if (!photoUri) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', `public, max-age=${RESOLVED_TTL_SECONDS}`);
    return res.redirect(302, photoUri);
  } catch (err) {
    // A provider failure is a missing image, not this server malfunctioning,
    // and the reason must never reach the client: the outbound request is
    // authenticated and its errors can echo request detail back.
    captureError(err, { provider: 'google-places', operation: 'photoProxy' });
    return res.status(502).json({ error: 'Photo unavailable' });
  }
});

export { placesPhotoRouter };
