import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

/**
 * REA review 2026-11-10 (X7). The Render origin (bytspot-api.onrender.com)
 * answers directly, so a caller can skip Cloudflare and forge
 * X-Forwarded-For to rotate per-IP rate-limit keys.
 *
 * With ORIGIN_LOCK_SECRET set, every request must carry the header
 * `x-bytspot-origin-auth: <secret>`, which a Cloudflare Transform Rule adds on
 * the way in (see docs/RENDER_ORIGIN_LOCK.md). Requests without it get 403,
 * except Render's health check and Stripe's signed webhooks. Only a request
 * that proved it came through Cloudflare has its client IP read from
 * CF-Connecting-IP; everything else keys on req.ip as before.
 *
 * Unset (today's production), this is a no-op, so deploying the code changes
 * nothing until Daniel configures Cloudflare and Render together.
 */
export const ORIGIN_AUTH_HEADER = 'x-bytspot-origin-auth';
const EXEMPT = [/^\/health(\/|$)/, /^\/webhooks\/stripe(\/|$)/];

function matches(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Incoming = { headers: Record<string, string | string[] | undefined>; ip?: string };

export function viaCloudflare(req: Pick<Incoming, 'headers'>, secret = config.originLockSecret): boolean {
  return Boolean(secret) && matches(req.headers[ORIGIN_AUTH_HEADER], secret);
}

/** The client address rate limits key on. */
export function trustedClientIp(req: Incoming, secret = config.originLockSecret): string | undefined {
  if (viaCloudflare(req, secret)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
  }
  return req.ip;
}

export function originLock(secret = config.originLockSecret) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!secret || EXEMPT.some((pattern) => pattern.test(req.path))) return next();
    if (matches(req.headers[ORIGIN_AUTH_HEADER], secret)) return next();
    res.status(403).json({ error: 'Use https://api.bytspot.app.' });
  };
}
