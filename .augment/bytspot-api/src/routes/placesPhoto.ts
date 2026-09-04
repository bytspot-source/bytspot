import { Router } from 'express';
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

/** Google's signed photoUri is short-lived, so this stays well inside it. */
const RESOLVED_TTL_SECONDS = 5 * 60;

export function isPhotoName(name: unknown): name is string {
  return typeof name === 'string' && PHOTO_NAME.test(name);
}

export function clampWidth(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(parsed)));
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
    if (hit) return hit;
  }

  // skipHttpRedirect returns the signed URI as JSON instead of a 302, so the
  // key stays in this process and only the keyless URI is ever forwarded.
  const url = `${GP_BASE}/${photoName}/media?maxWidthPx=${width}&skipHttpRedirect=true`;
  const response = await fetch(url, {
    headers: { 'X-Goog-Api-Key': config.googlePlacesApiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`google places photo ${response.status}`);
  const body = (await response.json()) as { photoUri?: unknown };
  const photoUri = typeof body.photoUri === 'string' ? body.photoUri : null;
  if (!photoUri) return null;

  if (redis) {
    await Promise.resolve(redis.set(cacheKey, photoUri, 'EX', RESOLVED_TTL_SECONDS)).catch(() => undefined);
  }
  return photoUri;
}

placesPhotoRouter.get('/places/photo', async (req, res) => {
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
