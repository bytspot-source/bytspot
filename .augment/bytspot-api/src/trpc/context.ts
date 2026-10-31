import * as trpcExpress from '@trpc/server/adapters/express';
import { createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthPayload } from '../middleware/auth';
import { rateLimitSubject } from './trpc';

/**
 * Creates the tRPC context from the Express request.
 * Extracts JWT auth if present (optional — procedures decide whether to require it).
 */
export function clientRateLimitKey(ipAddress: string | undefined, secret = config.jwtSecret): string {
  // `req.ip` is proxy-aware because index.ts trusts the Cloudflare → Render
  // chain. HMAC it so neither context nor Redis contains raw IPs or a
  // dictionary-reversible unsalted IP digest.
  const normalized = ipAddress?.trim() || 'unknown';
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

/** The signed-in user a request's Bearer token proves, or null. */
export function bearerUser(header: string | undefined): AuthPayload | null {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), config.jwtSecret) as AuthPayload;
  } catch {
    return null; /* invalid token — user stays null */
  }
}

/** Global limiter key: signed-in users by account, so people behind one shared
 *  address (a home network, a carrier gateway) do not use up each other's allowance. */
export function globalRateLimitKey(req: { headers: { authorization?: string }; ip?: string }): string {
  return rateLimitSubject(bearerUser(req.headers.authorization)?.userId, clientRateLimitKey(req.ip));
}

export async function createContext({
  req,
}: trpcExpress.CreateExpressContextOptions) {
  const user = bearerUser(req.headers.authorization);
  return { user, clientRateLimitKey: clientRateLimitKey(req.ip) };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

